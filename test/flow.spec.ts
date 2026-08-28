/**
 * Tests for the dive execution-flow trace — the redesign's core.
 *
 * The Goal: when the Data Flow fails, the error must carry both the DATA
 * (which instance) and the FLOW (the branch of execution that happened to
 * that data). These tests pin the trace mechanics:
 *
 *   - every wrapped invocation appends an edge
 *   - construction edges parent on the DATA-FLOW parent (the instance chain)
 *   - method calls continue the instance's own story at unwrapped boundaries
 *   - interleaved concurrent flows produce SEPARATE branches (the old
 *     switcher clobbering cannot corrupt the trace)
 *   - errors are pinned to their deepest edge (flight recorder)
 *   - the ring buffer bounds memory (oldest edges evicted)
 *   - async edges close at chain settlement ('ok' + full-lifetime duration);
 *     'running' means genuinely unsettled
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTypesCollection } from 'mnemonica/module';
import type { TypesCollection } from 'mnemonica/module';

import {
	wrap,
	current,
	getFlow,
	getTrace,
	getErrorInstance,
	isWrappedFunction,
	setTraceLimit,
	clear,
} from '../src/index.js';
import { attachHooks } from './helpers/attach-hooks.js';

describe('trace: construction edges follow the data flow', () => {
	let collection: TypesCollection;
	beforeEach(() => {
		clear();
		collection = createTypesCollection();
		attachHooks(collection);
	});

	it('a root creation records a create edge with no parent', () => {
		const Root = collection.define('Root', function (this: { id: string }, id: string) {
			this.id = id;
		});
		const instance = new Root('r1');

		const flow = getFlow(instance);
		expect(flow.length).toBe(1);
		expect(flow[0].kind).toBe('create');
		expect(flow[0].name).toBe('Root');
		expect(flow[0].instance).toBe(instance);
		expect(flow[0].parentId).toBeNull();
		// recordCreation fires at postCreation — the construction HAS completed,
		// so the edge closes immediately ('ok', unmeasured duration: 0);
		// 'running' is reserved for genuinely unsettled async work.
		expect(flow[0].status).toBe('ok');
		expect(flow[0].duration).toBe(0);
	});

	it('a subtype creation parents on the PARENT INSTANCE story, not on whatever ran last', () => {
		const Root = collection.define('Root', function (this: { id: string }, id: string) {
			this.id = id;
		});
		Root.define('Child', function (this: { extra: string }, extra: string) {
			this.extra = extra;
		});

		const a = new Root('A');
		const b = new Root('B');
		// b was created last — a naive "current cursor" parentage would put
		// a's child under b. The data-flow parentage must not.
		const childOfA = new a.Child('x');

		const flow = getFlow(childOfA);
		expect(flow.length).toBe(2);
		expect(flow[0].instance).toBe(a); // parent create edge
		expect(flow[1].instance).toBe(childOfA);
		expect(flow[1].parentId).toBe(flow[0].id);
		// b is nowhere in a's branch
		expect(flow.some((edge) => edge.instance === b)).toBe(false);
	});

	it('two root instances created in sequence get separate branches', () => {
		const Root = collection.define('Root', function (this: { id: string }, id: string) {
			this.id = id;
		});
		const a = new Root('A');
		const b = new Root('B');

		expect(getFlow(a).length).toBe(1);
		expect(getFlow(b).length).toBe(1);
		expect(getFlow(a)[0].id).not.toBe(getFlow(b)[0].id);
		expect(getFlow(a)[0].parentId).toBeNull();
		expect(getFlow(b)[0].parentId).toBeNull();
	});
});

describe('trace: method calls continue the instance story', () => {
	let collection: TypesCollection;
	beforeEach(() => {
		clear();
		collection = createTypesCollection();
		attachHooks(collection);
	});

	function defineWorker () {
		const Worker = collection.define('Worker', function (this: {
			id: string;
			work: (cb?: () => unknown) => unknown;
			inner: () => string;
			outer: () => string;
		}, id: string) {
			this.id = id;
			const proto = Object.getPrototypeOf(this) as Record<string, unknown>;
			proto.inner = function (this: object) {
				expect(current()).toBe(this);
				return 'inner';
			};
			proto.outer = function (this: { inner: () => string }) {
				return this.inner();
			};
		});
		return Worker;
	}

	it('a method call appends a method edge under the instance creation edge', () => {
		const Worker = defineWorker();
		const worker = new Worker('w1');

		worker.inner();

		const flow = getFlow(worker);
		expect(flow.length).toBe(2);
		expect(flow[0].kind).toBe('create');
		expect(flow[1].kind).toBe('method');
		expect(flow[1].name).toBe('inner');
		expect(flow[1].instance).toBe(worker);
		expect(flow[1].parentId).toBe(flow[0].id);
		expect(flow[1].status).toBe('ok');
		expect(flow[1].duration).toBeGreaterThanOrEqual(0);
	});

	it('a nested method call parents on the CALLER edge (execution truth)', () => {
		const Worker = defineWorker();
		const worker = new Worker('w1');

		worker.outer();

		// latest edge for worker is inner()'s edge; walking it must show
		// create → outer → inner
		const flow = getFlow(worker);
		expect(flow.map((edge) => edge.name)).toEqual(['Worker', 'outer', 'inner']);
		expect(flow.map((edge) => edge.kind)).toEqual(['create', 'method', 'method']);
		expect(flow[2].parentId).toBe(flow[1].id);
		expect(flow[1].parentId).toBe(flow[0].id);
	});

	it('two instances calling methods interleaved keep separate branches', () => {
		const Worker = defineWorker();
		const a = new Worker('A');
		const b = new Worker('B');

		a.inner();
		b.inner();
		a.inner();

		const flowA = getFlow(a);
		const flowB = getFlow(b);
		// sequential calls on the same instance chain linearly: each call
		// continues the instance's own timeline (create → inner → inner)
		expect(flowA.map((edge) => edge.name)).toEqual(['Worker', 'inner', 'inner']);
		expect(flowA.every((edge) => edge.instance === a)).toBe(true);
		expect(flowB.map((edge) => edge.name)).toEqual(['Worker', 'inner']);
		expect(flowB.every((edge) => edge.instance === b)).toBe(true);
	});
});

describe('trace: errors are flight recorders', () => {
	beforeEach(() => clear());

	it('an error thrown in a wrapped fn carries its branch and its data', () => {
		const ctx = { id: 'origin', requestId: 'req-1' };
		const err = new Error('boom');

		try {
			wrap(() => {
				throw err;
			}, ctx)();
			expect.fail('should have thrown');
		} catch (caught) {
			expect(caught).toBe(err);
			expect(getErrorInstance(err)).toBe(ctx);

			const flow = getFlow(err as Error);
			expect(flow.length).toBe(1);
			expect(flow[0].instance).toBe(ctx);
			expect(flow[0].status).toBe('error');
		}
	});

	it('the DEEPEST edge wins: a re-thrown error stays pinned at the failure site', () => {
		const innerCtx = { id: 'inner' };
		const outerCtx = { id: 'outer' };
		const err = new Error('deep boom');

		const inner = wrap(() => {
			throw err;
		}, innerCtx);
		const outer = wrap(() => inner(), outerCtx);

		try {
			outer();
			expect.fail('should have thrown');
		} catch (caught) {
			// pinned once, at the innermost wrapped boundary it passed through
			expect(getErrorInstance(caught as Error)).toBe(innerCtx);

			const flow = getFlow(caught as Error);
			expect(flow.length).toBe(2);
			expect(flow[0].instance).toBe(outerCtx); // outer called inner
			expect(flow[1].instance).toBe(innerCtx);
			expect(flow[1].status).toBe('error');
			expect(flow[0].status).toBe('error'); // error propagated through outer too
		}
	});

	it('a promise rejection pins the error to the call that produced it', async () => {
		const ctx = { id: 'async-origin' };
		const err = new Error('async boom');

		const fn = wrap(() => Promise.reject(err), ctx);
		await expect(fn()).rejects.toThrow('async boom');

		expect(getErrorInstance(err)).toBe(ctx);
		const flow = getFlow(err);
		expect(flow.length).toBe(1);
		expect(flow[0].instance).toBe(ctx);
		expect(flow[0].status).toBe('error');
	});

	it('a failed nested construction records the failure under the surviving parent', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const Parent = collection.define('Parent', function (this: { id: string }, id: string) {
			this.id = id;
		});
		const parent = new Parent('p1');
		Parent.define('Broken', function () {
			throw new Error('construction failed');
		});

		let caught: unknown;
		try {
			new parent.Broken();
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(getErrorInstance(caught as Error)).toBe(parent);

		const flow = getFlow(caught as Error);
		expect(flow.length).toBe(2);
		expect(flow[0].kind).toBe('create');
		expect(flow[0].instance).toBe(parent); // the surviving parent's story
		expect(flow[1].kind).toBe('create');
		expect(flow[1].name).toBe('Broken');
		expect(flow[1].status).toBe('error');
		expect(flow[1].parentId).toBe(flow[0].id);
	});
});

describe('trace: async edges close at chain settlement', () => {
	beforeEach(() => clear());

	it('a successful async call closes its edge ok with full-lifetime duration', async () => {
		const ctx = { id: 'async-ok' };
		const fn = wrap(async () => {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 30);
			});
			const result = 42;
			return result;
		}, ctx);

		const value = await fn();
		expect(value).toBe(42);

		const flow = getFlow(ctx);
		expect(flow.length).toBe(1);
		expect(flow[0].status).toBe('ok');
		expect(flow[0].duration).toBeGreaterThanOrEqual(25);
	});

	it('an edge reads running ONLY while the async work is genuinely unsettled', async () => {
		const ctx = { id: 'in-flight' };
		let gate: () => void = () => undefined;
		const fn = wrap(async () => {
			await new Promise<void>((resolve) => {
				gate = resolve;
			});
			const result = 1;
			return result;
		}, ctx);

		const pending = fn();
		// getFlow returns copies, so this is a snapshot of the in-flight state
		const midFlow = getFlow(ctx);
		expect(midFlow[0].status).toBe('running');

		gate();
		await pending;

		const endFlow = getFlow(ctx);
		expect(endFlow[0].status).toBe('ok');
	});

	it('a promise resolving to a promise closes the edge only at the true end', async () => {
		const ctx = { id: 'chain' };
		const fn = wrap(async () => {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 20);
			});
			const inner = (async () => {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 20);
				});
				const result = 'deep';
				return result;
			})();
			// assimilation: the outer promise adopts the inner one; the tap
			// fires only after the WHOLE chain settles, with the final value
			const result = inner;
			return result;
		}, ctx);

		const value = await fn();
		expect(value).toBe('deep');

		const flow = getFlow(ctx);
		expect(flow.length).toBe(1);
		expect(flow[0].status).toBe('ok');
		// duration covers BOTH legs, not just the synchronous head
		expect(flow[0].duration).toBeGreaterThanOrEqual(35);
	});

	it('a rejection INSIDE a nested promise chain pins the error to the call', async () => {
		const ctx = { id: 'chain-fail' };
		const err = new Error('deep async boom');
		const fn = wrap(async () => {
			const inner = (async () => {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 10);
				});
				throw err;
			})();
			const result = inner;
			return result;
		}, ctx);

		await expect(fn()).rejects.toThrow('deep async boom');
		expect(getErrorInstance(err)).toBe(ctx);

		const flow = getFlow(err);
		expect(flow.length).toBe(1);
		expect(flow[0].status).toBe('error');
	});

	it('a promise resolving to a function delivers it wrapped, context intact', async () => {
		const ctx = { id: 'fn-delivery' };
		const fn = wrap(async () => {
			const deliveredFn = () => 'delivered-value';
			return deliveredFn;
		}, ctx);

		const delivered = await fn();
		expect(isWrappedFunction(delivered)).toBe(true);

		// invoking it records its own edge against the captured context
		const value = (delivered as () => string)();
		expect(value).toBe('delivered-value');

		const flow = getFlow(ctx);
		expect(flow.length).toBe(2);
		expect(flow[0].status).toBe('ok'); // the delivering call closed at settle
		expect(flow[1].name).toBe('deliveredFn');
		expect(flow[1].instance).toBe(ctx);
		expect(flow[1].status).toBe('ok');
	});
});

describe('trace: interleaved concurrent flows stay separate', () => {
	beforeEach(() => clear());

	it('two flows failing interleaved recover their own data and branch', async () => {
		const a = { id: 'A', requestId: 'req-A' };
		const b = { id: 'B', requestId: 'req-B' };

		const errA = new Error('boom-A');
		const errB = new Error('boom-B');

		const cbA = wrap(() => {
			throw errA;
		}, a);
		const cbB = wrap(() => {
			throw errB;
		}, b);

		const seen: string[] = [];
		await Promise.all([
			new Promise<void>((resolve) => setTimeout(() => {
				try {
					cbA();
				} catch {
					seen.push('A');
				}
				resolve();
			}, 15)),
			new Promise<void>((resolve) => setTimeout(() => {
				try {
					cbB();
				} catch {
					seen.push('B');
				}
				resolve();
			}, 5)),
		]);

		expect(seen).toEqual(['B', 'A']); // B fired first — interleaved

		// The OLD dive would clobber: the last writer wins the global context.
		// The trace must give each error its OWN branch.
		expect(getErrorInstance(errA)).toBe(a);
		expect(getErrorInstance(errB)).toBe(b);

		const flowA = getFlow(errA);
		const flowB = getFlow(errB);
		expect(flowA.length).toBe(1);
		expect(flowB.length).toBe(1);
		expect(flowA[0].instance).toBe(a);
		expect(flowB[0].instance).toBe(b);
		expect(flowA[0].id).not.toBe(flowB[0].id);
	});

	it('wrap() restores context at rest — completed invocations do not leak', () => {
		const a = { id: 'A' };
		const b = { id: 'B' };

		// inside each closure the capture is restored truthfully…
		const readA = wrap(() => current(), a);
		const readB = wrap(() => current(), b);
		expect(readA()).toBe(a);
		expect(readB()).toBe(b);

		// …but at rest (outside any invocation) the switcher is back to
		// whatever preceded the call — here: nothing. Ambient "current" is
		// newest-wins ONLY where hooks/wrappers set it persistently (e.g.
		// postCreation); the trace never uses it for parentage.
		expect(current()).toBeUndefined();
	});
});

describe('trace: ring buffer bounds memory', () => {
	beforeEach(() => clear());

	it('evicts the oldest edges past the limit', () => {
		setTraceLimit(3);
		const collection = createTypesCollection();
		attachHooks(collection);

		const Root = collection.define('Root', function (this: { id: string }, id: string) {
			this.id = id;
		});

		const instances = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => new Root(id));

		// 5 create edges recorded, only the last 3 retained
		expect(getFlow(instances[0])).toEqual([]); // evicted
		expect(getFlow(instances[1])).toEqual([]); // evicted
		expect(getFlow(instances[2]).length).toBe(1);
		expect(getFlow(instances[4]).length).toBe(1);
		expect(getFlow(instances[4])[0].instance).toBe(instances[4]);
	});

	it('shrinking the limit evicts immediately', () => {
		const collection = createTypesCollection();
		attachHooks(collection);
		const Root = collection.define('Root', function () {});
		const a = new Root();

		expect(getFlow(a).length).toBe(1);
		setTraceLimit(0);
		expect(getFlow(a)).toEqual([]);
	});

	it('traceLimit 0 disables recording but context switching still works', () => {
		setTraceLimit(0);
		const ctx = { id: 'no-trace' };
		const fn = wrap(() => current(), ctx);
		expect(fn()).toBe(ctx); // wrap still restores context
		expect(getFlow(ctx)).toEqual([]); // but nothing was recorded
	});

	it('rejects invalid limits', () => {
		expect(() => setTraceLimit(-1)).toThrow();
		expect(() => setTraceLimit(1.5)).toThrow();
	});
});

describe('trace: getFlow target resolution', () => {
	beforeEach(() => clear());

	it('getFlow() with no target returns the current cursor branch (empty at rest)', () => {
		expect(getFlow()).toEqual([]);

		const ctx = { id: 'live' };
		wrap(() => {
			const flow = getFlow();
			expect(flow.length).toBe(1);
			expect(flow[0].instance).toBe(ctx);
		}, ctx)();

		expect(getFlow()).toEqual([]); // back to rest
	});

	it('getFlow on an unknown object returns an empty branch', () => {
		expect(getFlow({ never: 'seen' })).toEqual([]);
	});

	it('returned edges are copies — mutating them does not corrupt the trace', () => {
		const ctx = { id: 'immutable' };
		wrap(() => undefined, ctx)();

		const flow = getFlow(ctx);
		expect(flow.length).toBe(1);
		flow[0].name = 'MUTATED';
		flow[0].status = 'error';

		const fresh = getFlow(ctx);
		expect(fresh[0].name).not.toBe('MUTATED');
		expect(fresh[0].status).toBe('ok');
	});
});

describe('trace: getTrace dumps the whole ring', () => {
	beforeEach(() => clear());

	it('returns every retained edge, oldest first, with no target needed', () => {
		const ctxA = { id: 'a' };
		const ctxB = { id: 'b' };
		wrap(function first () { return 1; }, ctxA)();
		wrap(function second () { return 2; }, ctxB)();
		wrap(function third () { return 3; }, ctxA)();

		const trace = getTrace();
		expect(trace.length).toBe(3);
		expect(trace.map((edge) => edge.name)).toEqual(['first', 'second', 'third']);
		expect(trace[0].id).toBeLessThan(trace[1].id);
		expect(trace[1].id).toBeLessThan(trace[2].id);
	});

	it('is empty at rest on a fresh trace, unlike getFlow which needs a target', () => {
		expect(getTrace()).toEqual([]);
		expect(getFlow()).toEqual([]);
	});

	it('honors the ring limit — evicted edges are gone from the dump', () => {
		setTraceLimit(2);
		const ctx = { id: 'bounded' };
		wrap(function one () { return 1; }, ctx)();
		wrap(function two () { return 2; }, ctx)();
		wrap(function three () { return 3; }, ctx)();

		const trace = getTrace();
		expect(trace.map((edge) => edge.name)).toEqual(['two', 'three']);
	});

	it('returns copies — mutating the dump does not corrupt the trace', () => {
		const ctx = { id: 'immutable-dump' };
		wrap(function fn () { return 1; }, ctx)();

		const trace = getTrace();
		trace[0].name = 'MUTATED';

		const fresh = getTrace();
		expect(fresh[0].name).toBe('fn');
	});
});

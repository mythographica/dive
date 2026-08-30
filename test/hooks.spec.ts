/**
 * Edge lifecycle hooks — dive publishes its ground truth.
 *
 *   enter     → right after the edge is recorded; payload carries the fresh
 *               edge object ITSELF (symbol attachment = the reverse join) and
 *               the invocation args by reference
 *   leave     → the sync close, with what the wrap produced
 *   settle    → when a tapped promise chain closes (distinct from leave)
 *   recontext → a re-wrap handoff, linking old story to new
 *   create    → OPT-IN: a construction edge via recordCreation/
 *               recordCreationError; deliberately NOT enter (the adapter owns
 *               that lifecycle — enter would double-report there)
 *
 * Containment: a throwing subscriber degrades its own observability, never
 * the trace. clear() wipes subscribers — they must re-register after it.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
	wrap,
	registerHook,
	unregisterHook,
	clear,
	setTraceLimit,
	recordCreation,
	recordCreationError,
	type DiveEnterPayload,
	type DiveLeavePayload,
	type DiveSettlePayload,
	type DiveRecontextPayload,
	type DiveCreatePayload,
	type FlowEdge,
} from '../src/index.js';

const context = { name: 'ctx' };

describe('registerHook: enter', () => {
	beforeEach(() => clear());

	it('fires with the fresh edge object itself and the args by reference', () => {
		const seen: DiveEnterPayload[] = [];
		registerHook('enter', (payload) => {
			seen.push(payload);
		});

		function fn (this: unknown, a: number, b: string) {
			return a + b.length;
		}
		const wrapped = wrap(fn, context);
		const result = wrapped(2, 'abc');

		expect(result).toBe(5);
		expect(seen.length).toBe(1);
		expect(seen[0].edge.name).toBe('fn');
		expect(seen[0].edge.kind).toBe('call');
		expect(seen[0].edge.instance).toBe(context);
		expect(seen[0].args).toEqual([2, 'abc']);
	});

	it('the enter edge is the SAME object the leave hook later sees', () => {
		let entered: FlowEdge | undefined;
		let left: FlowEdge | undefined;
		registerHook('enter', ({ edge }) => {
			entered = edge;
		});
		registerHook('leave', ({ edge }) => {
			left = edge;
		});

		const wrapped = wrap(function fn () {
			return 1;
		}, context);
		wrapped();

		expect(entered).toBeDefined();
		expect(left).toBe(entered);
	});

	it('a subscriber may attach its own symbol to the edge (the reverse join)', () => {
		const spanId = Symbol('span');
		let attached: unknown;
		registerHook('enter', ({ edge }) => {
			(edge as unknown as Record<symbol, unknown>)[spanId] = 'span-1';
		});
		registerHook('leave', ({ edge }) => {
			attached = (edge as unknown as Record<symbol, unknown>)[spanId];
		});

		const wrapped = wrap(function fn () {
			return 1;
		}, context);
		wrapped();

		expect(attached).toBe('span-1');
	});

	it('fires for constructor calls with kind construct', () => {
		const kinds: string[] = [];
		registerHook('enter', ({ edge }) => {
			kinds.push(edge.kind);
		});

		function Thing (this: { v: number }, v: number) {
			this.v = v;
		}
		const Wrapped = wrap(Thing, context);
		const instance = Reflect.construct(Wrapped, [42]);

		expect(instance.v).toBe(42);
		expect(kinds).toEqual(['construct']);
	});
});

describe('registerHook: leave', () => {
	beforeEach(() => clear());

	it('carries what the wrap produced: a plain value', () => {
		const seen: DiveLeavePayload[] = [];
		registerHook('leave', (payload) => {
			seen.push(payload);
		});

		const wrapped = wrap(function fn () {
			return 'plain';
		}, context);
		wrapped();

		expect(seen.length).toBe(1);
		expect(seen[0].result).toBe('plain');
		expect(seen[0].edge.status).toBe('ok');
		expect(typeof seen[0].edge.duration).toBe('number');
	});

	it('carries the tapped promise when the result is async', () => {
		const seen: DiveLeavePayload[] = [];
		registerHook('leave', (payload) => {
			seen.push(payload);
		});

		const wrapped = wrap(async function fn () {
			return 'async-value';
		}, context);
		wrapped();

		expect(seen.length).toBe(1);
		expect(seen[0].result instanceof Promise).toBe(true);
	});

	it('sees an error status and undefined result when the call throws', () => {
		const seen: DiveLeavePayload[] = [];
		registerHook('leave', (payload) => {
			seen.push(payload);
		});

		const wrapped = wrap(function fn (): unknown {
			throw new Error('boom');
		}, context);
		expect(() => wrapped()).toThrow('boom');

		expect(seen.length).toBe(1);
		expect(seen[0].result).toBe(undefined);
		expect(seen[0].edge.status).toBe('error');
	});
});

describe('registerHook: settle', () => {
	beforeEach(() => clear());

	it('fires when the tapped chain resolves, with the final value', async () => {
		const seen: DiveSettlePayload[] = [];
		registerHook('settle', (payload) => {
			seen.push(payload);
		});

		const wrapped = wrap(async function fn () {
			return 'done';
		}, context);
		const result = await wrapped();

		expect(result).toBe('done');
		expect(seen.length).toBe(1);
		expect(seen[0].result).toBe('done');
		expect(seen[0].error).toBe(undefined);
	});

	it('a resolved function is settled in its wrapped form', async () => {
		const seen: DiveSettlePayload[] = [];
		registerHook('settle', (payload) => {
			seen.push(payload);
		});

		const wrapped = wrap(async function fn () {
			const inner = function inner () {
				return 7;
			};
			return inner;
		}, context);
		const resolved = await wrapped() as unknown as () => number;

		expect(resolved()).toBe(7);
		expect(seen.length).toBe(1);
		expect(seen[0].result).toBe(resolved);
	});

	it('fires with the error when the chain rejects', async () => {
		const seen: DiveSettlePayload[] = [];
		registerHook('settle', (payload) => {
			seen.push(payload);
		});

		const failure = new Error('async boom');
		const wrapped = wrap(async function fn (): Promise<unknown> {
			throw failure;
		}, context);
		await expect(wrapped()).rejects.toThrow('async boom');

		expect(seen.length).toBe(1);
		expect(seen[0].error).toBe(failure);
		expect(seen[0].result).toBe(undefined);
	});

	it('leave and settle are DISTINCT moments: sync head first, work done later', async () => {
		const order: string[] = [];
		registerHook('leave', () => {
			order.push('leave');
		});
		registerHook('settle', () => {
			order.push('settle');
		});

		const wrapped = wrap(async function fn () {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return 1;
		}, context);
		await wrapped();

		expect(order).toEqual(['leave', 'settle']);
	});
});

describe('registerHook: recontext', () => {
	beforeEach(() => clear());

	it('fires on an explicit re-wrap with a different context', () => {
		const seen: DiveRecontextPayload[] = [];
		registerHook('recontext', (payload) => {
			seen.push(payload);
		});

		const other = { name: 'other' };
		function fn () {
			return 1;
		}
		const first = wrap(fn, context);
		const second = wrap(first, other);

		expect(second).not.toBe(first);
		expect(seen.length).toBe(1);
		expect(seen[0].edge.kind).toBe('recontext');
		expect(seen[0].previousContext).toBe(context);
		expect(seen[0].context).toBe(other);
		expect(seen[0].fn).toBe(fn);
	});

	it('does NOT fire for an idempotent re-wrap (no/same context)', () => {
		let fired = 0;
		registerHook('recontext', () => {
			fired++;
		});

		const wrapped = wrap(function fn () {
			return 1;
		}, context);
		wrap(wrapped);
		wrap(wrapped, context);

		expect(fired).toBe(0);
	});
});

describe('registerHook: containment and lifecycle', () => {
	beforeEach(() => clear());

	it('a throwing subscriber degrades itself, never the trace', () => {
		const healthy: string[] = [];
		registerHook('enter', () => {
			throw new Error('broken subscriber');
		});
		registerHook('enter', ({ edge }) => {
			healthy.push(edge.name);
		});

		const wrapped = wrap(function fn () {
			return 'untouched';
		}, context);
		const result = wrapped();

		expect(result).toBe('untouched');
		expect(healthy).toEqual(['fn']);
	});

	it('a throwing settle subscriber never swallows the rejection', async () => {
		registerHook('settle', () => {
			throw new Error('broken subscriber');
		});

		const wrapped = wrap(async function fn (): Promise<unknown> {
			throw new Error('real failure');
		}, context);
		await expect(wrapped()).rejects.toThrow('real failure');
	});

	it('the returned unregister function detaches the subscriber', () => {
		let fired = 0;
		const unregister = registerHook('enter', () => {
			fired++;
		});

		const wrapped = wrap(function fn () {
			return 1;
		}, context);
		wrapped();
		unregister();
		unregister();
		wrapped();

		expect(fired).toBe(1);
	});

	it('unregisterHook detaches an exact subscriber by reference', () => {
		let fired = 0;
		let other = 0;
		const subscriber = (): void => {
			fired++;
		};
		registerHook('enter', subscriber);
		registerHook('enter', () => {
			other++;
		});

		const wrapped = wrap(function fn () {
			return 1;
		}, context);
		wrapped();
		unregisterHook('enter', subscriber);
		unregisterHook('enter', subscriber);
		wrapped();

		expect(fired).toBe(1);
		expect(other).toBe(2);
	});

	it('clear() wipes the subscribers', () => {
		let fired = 0;
		registerHook('enter', () => {
			fired++;
		});

		clear();
		const wrapped = wrap(function fn () {
			return 1;
		}, context);
		wrapped();

		expect(fired).toBe(0);
	});

	it('no events fire when the trace is disabled (traceLimit 0)', () => {
		setTraceLimit(0);
		let fired = 0;
		registerHook('enter', () => {
			fired++;
		});
		registerHook('leave', () => {
			fired++;
		});

		const wrapped = wrap(function fn () {
			return 1;
		}, context);
		const result = wrapped();

		expect(result).toBe(1);
		expect(fired).toBe(0);
	});
});

describe('registerHook: create (opt-in construction edges)', () => {
	beforeEach(() => clear());

	it('fires on recordCreation with the finalized edge and no error', () => {
		const seen: DiveCreatePayload[] = [];
		registerHook('create', (payload) => {
			seen.push(payload);
		});

		const instance = { name: 'inst' };
		recordCreation('MyType', instance);

		expect(seen.length).toBe(1);
		expect(seen[0].edge.name).toBe('MyType');
		expect(seen[0].edge.kind).toBe('create');
		expect(seen[0].edge.status).toBe('ok');
		expect(seen[0].edge.duration).toBe(0);
		expect(seen[0].edge.instance).toBe(instance);
		expect(seen[0].error).toBeUndefined();
	});

	it('carries the data-flow parentage of the construction', () => {
		const seen: DiveCreatePayload[] = [];
		registerHook('create', (payload) => {
			seen.push(payload);
		});

		const parentInst = { name: 'parent' };
		const childInst = { name: 'child' };
		recordCreation('Parent', parentInst);
		recordCreation('Child', childInst, parentInst);

		expect(seen.length).toBe(2);
		expect(seen[1].edge.parentId).toBe(seen[0].edge.id);
	});

	it('does NOT fire as enter — the adapter owns the construction domain', () => {
		let entered = 0;
		registerHook('enter', () => {
			entered++;
		});

		recordCreation('MyType', { name: 'inst' });

		expect(entered).toBe(0);
	});

	it('fires on recordCreationError with the error pinned and set', () => {
		const seen: DiveCreatePayload[] = [];
		registerHook('create', (payload) => {
			seen.push(payload);
		});

		const failure = new Error('boom');
		recordCreationError('BrokenType', failure);

		expect(seen.length).toBe(1);
		expect(seen[0].edge.name).toBe('BrokenType');
		expect(seen[0].edge.kind).toBe('create');
		expect(seen[0].edge.status).toBe('error');
		expect(seen[0].error).toBe(failure);
	});

	it('the returned unregister function detaches the subscriber', () => {
		let fired = 0;
		const unregister = registerHook('create', () => {
			fired++;
		});

		recordCreation('MyType', { name: 'a' });
		unregister();
		recordCreation('MyType', { name: 'b' });

		expect(fired).toBe(1);
	});

	it('clear() wipes the subscribers', () => {
		let fired = 0;
		registerHook('create', () => {
			fired++;
		});

		clear();
		recordCreation('MyType', { name: 'inst' });

		expect(fired).toBe(0);
	});

	it('no create event fires when the trace is disabled (traceLimit 0)', () => {
		setTraceLimit(0);
		let fired = 0;
		registerHook('create', () => {
			fired++;
		});

		recordCreation('MyType', { name: 'inst' });

		expect(fired).toBe(0);
	});
});

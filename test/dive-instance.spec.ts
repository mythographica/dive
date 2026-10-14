/**
 * new Dive() — an isolated dive next to the default one.
 *
 * The isolation rules pinned here (AGENTS.md "One dive per story"):
 *
 *   1. State is the boundary: each dive owns its edges, counters, stats,
 *      running store, hooks and context — one dive's hooks never fire for
 *      another dive's calls.
 *   2. clear() resets exactly one dive.
 *   3. Wrap marks are SHARED on purpose: the Symbol.for keys live on the
 *      user's functions and errors, so wrappedness and double-wrap detection
 *      work no matter which dive (or build flavor) meets the function.
 *      Recording always lands in the dive whose API performed the wrap.
 *   4. Cross-dive re-wrap is the same shadowing as in one dive: the
 *      'recontext' handoff edge is recorded in the ACTING dive, wrappers
 *      never stack (the fresh wrapper always wraps the ORIGINAL fn).
 *   5. Cross-dive nesting keeps each story to its own dive: a call wrapped
 *      by dive A records only in dive A — even inside a call wrapped by
 *      dive B it does not become a child of B's edge — and each dive's
 *      cursor, activeDepth and current() are its own.
 *   6. The read side honours the boundary too: a dive's getFlow() starts
 *      only from its OWN edges — a foreign edge, copy or pinned error is
 *      not an anchor here (getErrorInstance stays state-free: the crash
 *      handler must recover the data whichever dive it holds).
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
	Dive,
	wrap,
	current,
	getFlow,
	registerHook,
	clear,
	stats,
} from '../src/index.js';

const SymbolDiveOriginal = Symbol.for('mnemonica.dive.original');

describe('new Dive() — isolated dives', () => {

	beforeEach(() => {
		clear();
	});

	it('records its own edges, invisible to the default dive', () => {
		const app = new Dive();
		const ctxApp = { id : 'app' };
		const ctxDef = { id : 'default' };
		const appFn = app.wrap(function appWork () {
			return 1;
		}, ctxApp);
		const defFn = wrap(function defaultWork () {
			return 2;
		}, ctxDef);
		appFn();
		defFn();
		expect(app.stats.recorded).toBe(1);
		expect(stats.recorded).toBe(1);
		// each dive reads only its own story
		expect(app.getFlow(ctxApp).length).toBe(1);
		expect(app.getFlow(ctxDef).length).toBe(0);
		expect(getFlow(ctxDef).length).toBe(1);
		expect(getFlow(ctxApp).length).toBe(0);
	});

	it('one dive\'s hooks never fire for another dive\'s calls', () => {
		const app = new Dive();
		const appEvents: string[] = [];
		const defEvents: string[] = [];
		app.registerHook('enter', ({ edge }) => {
			appEvents.push(edge.name);
		});
		registerHook('enter', ({ edge }) => {
			defEvents.push(edge.name);
		});
		app.wrap(function appOnly () {
			return 1;
		}, {})();
		wrap(function defaultOnly () {
			return 2;
		}, {})();
		expect(appEvents).toEqual([ 'appOnly' ]);
		expect(defEvents).toEqual([ 'defaultOnly' ]);
	});

	it('clear() on one dive leaves the other untouched', () => {
		const app = new Dive();
		const ctxApp = { id : 'app' };
		const ctxDef = { id : 'default' };
		const defEvents: string[] = [];
		registerHook('enter', ({ edge }) => {
			defEvents.push(edge.name);
		});
		app.wrap(function appWork () {
			return 1;
		}, ctxApp)();
		wrap(function defaultWork () {
			return 2;
		}, ctxDef)();
		app.clear();
		expect(app.stats.recorded).toBe(0);
		expect(app.getFlow(ctxApp)).toEqual([]);
		expect(app.current()).toBeUndefined();
		// the default dive is untouched: counters, trace, subscribers
		expect(stats.recorded).toBe(1);
		expect(getFlow(ctxDef).length).toBe(1);
		wrap(function again () {
			return 3;
		}, ctxDef)();
		expect(defEvents).toEqual([ 'defaultWork', 'again' ]);
	});

	it('shares the wrap marks: no double-wrap across dives, re-root records only in the acting dive', () => {
		const app = new Dive();
		const ctxA = { id : 'a' };
		const ctxB = { id : 'b' };
		function shared () {
			return 1;
		}
		const wrappedByDefault = wrap(shared, ctxA);
		// wrappedness is a property of the function object, seen by every dive
		expect(app.isWrappedFunction(wrappedByDefault)).toBe(true);
		// auto-wrap crossings stay idempotent across dives: an app-wrapped call
		// receives the default dive's wrapper untouched
		let received: unknown;
		const passer = app.wrap(function passer (cb: unknown) {
			received = cb;
			return 0;
		}, ctxB);
		passer(wrappedByDefault);
		expect(received).toBe(wrappedByDefault);
		const beforeApp = app.stats.recorded;
		const beforeDef = stats.recorded;
		// explicit re-wrap with a DIFFERENT context: the ownership handoff is
		// recorded in the acting dive only
		const rerooted = app.wrap(wrappedByDefault, ctxB);
		expect(rerooted).not.toBe(wrappedByDefault);
		expect(app.stats.recorded).toBe(beforeApp + 1);
		expect(stats.recorded).toBe(beforeDef);
		rerooted();
		expect(app.stats.recorded).toBe(beforeApp + 2);
		expect(stats.recorded).toBe(beforeDef);
		// wrappers never stack: the fresh wrapper wraps the ORIGINAL fn
		const origin: unknown = SymbolDiveOriginal in rerooted ? rerooted[ SymbolDiveOriginal ] : undefined;
		expect(origin).toBe(shared);
		// the handoff edge roots the re-rooted story inside the acting dive
		const branch = app.getFlow(ctxB);
		expect(branch.map((edge) => edge.kind)).toEqual([ 'recontext', 'call' ]);
	});

	it('cross-dive nesting keeps each story to its own dive', () => {
		const app = new Dive();
		const ctxDef = { id : 'default-ctx' };
		const ctxApp = { id : 'app-ctx' };
		let innerCurrentDef: object | undefined;
		let innerCurrentApp: object | undefined;
		const inner = wrap(function innerWork () {
			innerCurrentDef = current();
			innerCurrentApp = app.current();
			return 1;
		}, ctxDef);
		const outer = app.wrap(function outerWork () {
			inner();
			return 2;
		}, ctxApp);
		outer();
		// each dive's current() is its own — the nested default-dive call did
		// not disturb the app's switcher
		expect(innerCurrentDef).toBe(ctxDef);
		expect(innerCurrentApp).toBe(ctxApp);
		// the inner edge roots a NEW branch in the default dive — parentage
		// never crosses dives, even though it ran inside the app's wrapped call
		const defBranch = getFlow(ctxDef);
		expect(defBranch.length).toBe(1);
		expect(defBranch[ 0 ].parentId).toBeNull();
		const appBranch = app.getFlow(ctxApp);
		expect(appBranch.length).toBe(1);
		expect(appBranch[ 0 ].name).toBe('outerWork');
	});

	it('wrapInstanceMethods is first-dive-wins: the shared mark skips the second dive', () => {
		const app = new Dive();
		const other = new Dive();
		const appKinds: string[] = [];
		const otherKinds: string[] = [];
		app.registerHook('enter', ({ edge }) => {
			appKinds.push(edge.kind);
		});
		other.registerHook('enter', ({ edge }) => {
			otherKinds.push(edge.kind);
		});
		class Svc {
			run () {
				return 1;
			}
		}
		const svc = new Svc();
		app.wrapInstanceMethods(svc);
		other.wrapInstanceMethods(svc);
		svc.run();
		expect(appKinds).toEqual([ 'method' ]);
		expect(otherKinds).toEqual([]);
		expect(app.stats.recorded).toBe(1);
		expect(other.stats.recorded).toBe(0);
	});

	it('runs the full machinery on its own state: async settle and error pinning', async () => {
		const app = new Dive();
		const ctx = { id : 'app' };
		const boom = new Error('boom');
		const failing = app.wrap(async function failing () {
			throw boom;
		}, ctx);
		await expect(failing()).rejects.toBe(boom);
		// the pin rides on the error object — getErrorInstance reads it from any dive
		expect(app.getErrorInstance(boom)).toBe(ctx);
		const branch = app.getFlow(boom);
		expect(branch.map((edge) => [ edge.kind, edge.status ])).toEqual([ [ 'call', 'error' ] ]);
		// the default dive did not record the pinned edge — it is not an anchor there
		expect(getFlow(boom)).toEqual([]);
	});

	it('a foreign edge copy does not anchor a flow walk in another dive', () => {
		const app = new Dive();
		const ctx = { id : 'app' };
		app.wrap(function appWork () {
			return 1;
		}, ctx)();
		const [ appEdge ] = app.getFlow(ctx);
		// the same copy resolves in its own dive, not in the default one
		expect(app.getFlow(appEdge).length).toBe(1);
		expect(getFlow(appEdge)).toEqual([]);
	});

	it('drops only its own trace: edge.drop() never touches another dive', () => {
		const app = new Dive();
		const ctxApp = { id : 'app' };
		const ctxDef = { id : 'default' };
		app.wrap(function appWork () {
			return 1;
		}, ctxApp)();
		wrap(function defaultWork () {
			return 2;
		}, ctxDef)();
		const [ appEdge ] = app.getFlow(ctxApp);
		appEdge.drop();
		expect(app.getFlow(ctxApp)).toEqual([]);
		expect(getFlow(ctxDef).length).toBe(1);
	});

	it('two app dives are independent of each other, not only of the default', () => {
		const first = new Dive();
		const second = new Dive();
		const ctxOne = { id : 'one' };
		const ctxTwo = { id : 'two' };
		first.wrap(function firstWork () {
			return 1;
		}, ctxOne)();
		second.wrap(function secondWork () {
			return 2;
		}, ctxTwo)();
		expect(first.stats.recorded).toBe(1);
		expect(second.stats.recorded).toBe(1);
		expect(first.getFlow(ctxOne).length).toBe(1);
		expect(first.getFlow(ctxTwo)).toEqual([]);
		expect(second.getFlow(ctxTwo).length).toBe(1);
		expect(second.getFlow(ctxOne)).toEqual([]);
	});

	it('exposes the full integration surface on its own state', async () => {
		const app = new Dive();
		const events: string[] = [];
		const off = app.registerHook('create', ({ edge }) => {
			events.push(`${edge.kind}:${edge.name}`);
		});
		const parent = { id : 'parent' };
		const child = { id : 'child' };
		app.enterContext(parent);
		expect(app.current()).toBe(parent);

		// the constructor-arg dance (attachHooks' preCreation/postCreation)
		let cbCurrent: unknown;
		const cb = app.wrapConstructorArg(function savedCallback () {
			cbCurrent = app.current();
			return 1;
		}, parent);
		app.recordCreation('Child', child, parent);
		// unused during construction → upgraded to the built instance
		app.upgradeConstructorArg(cb, child);
		cb();
		expect(cbCurrent).toBe(child);

		// a running edge: a promise that has not settled yet
		let release: (value: number) => void = () => {};
		const pending = new Promise<number>((resolve) => {
			release = resolve;
		});
		const pendingFn = app.wrap(function pendingWork () {
			return pending;
		}, child);
		const resultPromise = pendingFn();
		expect(app.getRunningEdges().map((edge) => edge.name)).toEqual([ 'pendingWork' ]);
		expect(app.chainDepth(child)).toBe(3);
		expect(app.getFlow(child).map((edge) => edge.name)).toEqual([ 'Child', 'savedCallback', 'pendingWork' ]);
		release(42);
		await resultPromise;
		expect(app.getRunningEdges()).toEqual([]);

		// a failed construction under the surviving parent
		const failure = new Error('construct failed');
		app.recordCreationError('Broken', failure, parent);
		expect(app.getErrorInstance(failure)).toBe(parent);
		expect(events).toEqual([ 'create:Child', 'create:Broken' ]);

		// unregister by exact reference (no unregister closure kept)
		const namedHook = (): void => {
			events.push('named');
		};
		app.registerHook('create', namedHook);
		app.unregisterHook('create', namedHook);
		// and the returned unregister closure
		off();
		app.recordCreation('After', { id : 'after' }, parent);
		expect(events).toEqual([ 'create:Child', 'create:Broken' ]);

		// the default dive saw none of it
		expect(stats.recorded).toBe(0);
	});
});

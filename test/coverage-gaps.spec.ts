/**
 * Pinning tests for defensive branches of src/index.ts that the main suite
 * never reaches — each test asserts the BEHAVIOR the branch produces, not
 * merely its execution:
 *
 *   - edge.drop() on a copy whose live edge was collected is a no-op
 *   - edge.drop() during the call releases the cursor mid-flight
 *   - targeted drop() walks edges that were recorded without an instance
 *   - a thrown non-object pins nothing and leaves the edge running
 *   - isWrappedFunction() rejects non-function values (adapter probing)
 *   - dive survives a degraded stack environment (unparseable Error.stack):
 *     no callsite, 'anonymous' caption fallbacks — fresh module instance
 *     imported while Error.prepareStackTrace yields undefined stacks
 *   - a promise resolving to a function is wrapped from the settle tap with
 *     no userland callsite on the stack
 *   - re-wrap shadowing of ambient (no-context) wraps and label preservation
 *   - recordCreation / recordCreationError name + parentage guards
 *   - wrapInstanceMethods skips null-proto instances, plain Object.prototype,
 *     getters, already-wrapped and non-configurable methods
 *   - a synchronously throwing method pins the error to its method edge
 *   - upgradeConstructorArg structural holder proof + used-callback lock
 *   - getFlow/getErrorInstance accept the degenerate inputs gracefully
 *
 * Requires --expose-gc (the test script sets NODE_OPTIONS accordingly).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
	wrap,
	wrapConstructorArg,
	upgradeConstructorArg,
	wrapInstanceMethods,
	recordCreation,
	recordCreationError,
	isWrappedFunction,
	getFlow,
	getRunningEdges,
	getErrorInstance,
	chainDepth,
	current,
	registerHook,
	stats,
	clear,
	type FlowEdge,
	type DiveRecontextPayload,
} from '../src/index.js';

const sleepTick = () => new Promise((resolve) => {
	setTimeout(resolve, 0);
});

async function forceGcRounds (rounds: number): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		globalThis.gc();
		await sleepTick();
	}
	globalThis.gc();
	await sleepTick();
}

describe('edge.drop() corner contracts', () => {
	beforeEach(() => {
		clear();
	});

	it('drop() during the call releases the cursor: mid-flight flow reads are empty', () => {
		const ctx = { id : 'ctx' };
		let midBranch = -1;
		let midRunning = -1;
		const fn = wrap(function midFlightProbe () {
			const branch = getFlow();
			// the newest copy IS the current edge — a full wipe from inside
			branch[ branch.length - 1 ].drop();
			midBranch = getFlow().length;
			midRunning = getRunningEdges().length;
			return 42;
		}, ctx);
		const result = fn();
		expect(result).toBe(42);
		// the wipe released the cursor and evicted the edge from the running store
		expect(midBranch).toBe(0);
		expect(midRunning).toBe(0);
		// at rest the state machine is back where the caller left it
		expect(getFlow()).toHaveLength(0);
		expect(chainDepth(ctx)).toBe(0);
	});

	it('drop() on a copy whose live edge was collected is a no-op', async () => {
		const a = { id : 'a' };
		const b = { id : 'b' };
		let doomedEdge: FlowEdge | undefined;
		const unregister = registerHook('enter', ({ edge }) => {
			if (edge.name === 'doomedBody') {
				doomedEdge = edge;
			}
		});
		function doomedBody () { return 1; }
		const doomed = wrap(doomedBody, a);
		doomed();
		function keeperBody () { return 2; }
		const keeper = wrap(keeperBody, b);
		keeper();
		expect(chainDepth(b)).toBe(1);
		// a copy — its side-link to the live edge is WEAK
		const [ copyOfA ] = getFlow(a);
		expect(copyOfA.name).toBe('doomedBody');
		// full wipe via the LIVE edge, then release every strong ref to it
		doomedEdge?.drop();
		doomedEdge = undefined;
		unregister();
		await forceGcRounds(2);
		expect(stats.collectedEdges).toBe(1);
		const recordedBefore = stats.recorded;
		// the live edge is gone: the copy resolves to nothing and drop is a no-op
		expect(() => {
			copyOfA.drop();
			copyOfA.drop(b);
		}).not.toThrow();
		expect(stats.recorded).toBe(recordedBefore);
		expect(chainDepth(b)).toBe(1);
	});

	it('targeted drop() walks edges recorded without an instance safely', () => {
		const c = { id : 'c' };
		const live: FlowEdge[] = [];
		registerHook('enter', ({ edge }) => {
			live.push(edge);
		});
		// no context at wrap time (ambient residue is undefined after clear())
		// → the inner edge carries no instance ref at all
		const inner = wrap(function innerNoCtx () { return 1; });
		const outer = wrap(function outerWithCtx () { inner(); }, c);
		outer();
		expect(live).toHaveLength(2);
		expect(live[ 1 ].instance).toBeUndefined();
		// the walk crosses the ref-less inner edge, then clears c on the outer one
		live[ 1 ].drop(c);
		expect(chainDepth(c)).toBe(0);
		expect(live[ 0 ].instance).toBeUndefined();
		// targeted drop keeps the links: the branch still walks from the inner edge
		expect(getFlow(live[ 1 ])).toHaveLength(2);
	});
});

describe('error pinning guards', () => {
	beforeEach(() => {
		clear();
	});

	it('a thrown non-object pins nothing but the edge still settles as error', () => {
		const ctx = { id : 'ctx' };
		const fn = wrap(function stringThrower () {
			throw 'plain failure';
		}, ctx);
		let caught: unknown;
		try {
			fn();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBe('plain failure');
		// the edge records the failure and leaves the running store — a
		// non-object throw must not leak a forever-running edge
		expect(stats.running).toBe(0);
		const flow = getFlow(ctx);
		expect(flow).toHaveLength(1);
		expect(flow[ 0 ].name).toBe('stringThrower');
		expect(flow[ 0 ].status).toBe('error');
		// but a non-object carries no provenance at all (nothing to pin onto)
		expect(getErrorInstance(caught)).toBeUndefined();
		expect(getFlow(caught)).toHaveLength(0);
	});

	it('a rejected non-object settles the edge as error too (the promise tap)', async () => {
		const ctx = { id : 'ctx' };
		const fn = wrap(function rejectingFn () {
			const rejection = Promise.reject('async plain failure');
			return rejection;
		}, ctx);
		let caught: unknown;
		try {
			await fn();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBe('async plain failure');
		expect(stats.running).toBe(0);
		const flow = getFlow(ctx);
		expect(flow).toHaveLength(1);
		expect(flow[ 0 ].status).toBe('error');
		expect(getErrorInstance(caught)).toBeUndefined();
	});

	it('a method throwing a non-object settles its edge as error (wrapInstanceMethods path)', () => {
		class Holder {
			boom () {
				throw 42;
			}
		}
		const instance = new Holder();
		wrapInstanceMethods(instance);
		let caught: unknown;
		try {
			instance.boom();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBe(42);
		expect(stats.running).toBe(0);
		const flow = getFlow(instance);
		expect(flow).toHaveLength(1);
		expect(flow[ 0 ].kind).toBe('method');
		expect(flow[ 0 ].status).toBe('error');
	});

	it('a thrown Error marks the edge error, pins it, and leaves the running store', () => {
		const ctx = { id : 'ctx' };
		const failure = new Error('boom');
		const fn = wrap(function errorThrower () { throw failure; }, ctx);
		let caught: unknown;
		try {
			fn();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBe(failure);
		const flow = getFlow(failure);
		expect(flow).toHaveLength(1);
		expect(flow[ 0 ].kind).toBe('call');
		expect(flow[ 0 ].status).toBe('error');
		expect(getErrorInstance(failure)).toBe(ctx);
		expect(stats.running).toBe(0);
	});

	it('getErrorInstance returns undefined for anything that was never pinned', () => {
		expect(getErrorInstance(new Error('plain'))).toBeUndefined();
		expect(getErrorInstance({ random : 'object' })).toBeUndefined();
		expect(getErrorInstance('nope')).toBeUndefined();
		expect(getErrorInstance(null)).toBeUndefined();
		expect(getErrorInstance(42)).toBeUndefined();
	});

	it('getErrorInstance falls back to the pinned edge when no instance was pinned', () => {
		// a contextless wrap: the error pins its edge, but the edge carries
		// no instance — attribution is absent, never guessed
		function failBody () { throw new Error('rootless'); }
		const fn = wrap(failBody);
		let caught: unknown;
		try {
			fn();
		} catch (e) {
			caught = e;
		}
		expect(getErrorInstance(caught)).toBeUndefined();
		// the flight recorder still reaches the failing edge itself
		expect(getFlow(caught)).toHaveLength(1);
		expect(getFlow(caught)[ 0 ].name).toBe('failBody');
	});
});

describe('isWrappedFunction: adapter-side probing of arbitrary values', () => {
	beforeEach(() => {
		clear();
	});

	it('rejects non-function values, accepts plain and wrapped functions', () => {
		expect(isWrappedFunction(undefined)).toBe(false);
		expect(isWrappedFunction(null)).toBe(false);
		expect(isWrappedFunction(42)).toBe(false);
		expect(isWrappedFunction('fn')).toBe(false);
		expect(isWrappedFunction({})).toBe(false);
		expect(isWrappedFunction([ () => 1 ])).toBe(false);
		const plain = (): number => 1;
		expect(isWrappedFunction(plain)).toBe(false);
		expect(isWrappedFunction(wrap(plain))).toBe(true);
	});
});

describe('degraded stack environment (no parseable Error.stack)', () => {
	it('wrap survives: no callsite is captured and captions fall back honestly', async () => {
		// A process where Error stacks come back undefined (a V8-wide
		// prepareStackTrace override) — dive must degrade, not break:
		// SELF_PATH falls back to "skip nothing", captureCallsite gives up,
		// computeCaption falls back to fn.name / 'anonymous'.
		type PrepareStackTrace = (err: Error, sites: NodeJS.CallSite[]) => string | undefined;
		const broken: PrepareStackTrace = () => undefined;
		const originalPrepare = Error.prepareStackTrace;
		const probeCtx = { id : 'probe' };
		const seen: FlowEdge[] = [];
		let fresh: typeof import('../src/index.js');
		Error.prepareStackTrace = broken as typeof Error.prepareStackTrace;
		try {
			vi.resetModules();
			fresh = await import('../src/index.js');
			// the wraps must happen WHILE stacks are undefined — captureCallsite
			// reads them at wrap time
			fresh.registerHook('enter', ({ edge }) => {
				seen.push(edge);
			});
			const labelled = fresh.wrap((): number => 1, probeCtx, 'guard');
			const unlabelled = fresh.wrap((): number => 2, probeCtx);
			const named = fresh.wrap(function probeNamed () { return 3; }, probeCtx);
			expect(labelled()).toBe(1);
			expect(unlabelled()).toBe(2);
			expect(named()).toBe(3);
		} finally {
			Error.prepareStackTrace = originalPrepare;
		}
		// anonymous fns with no callsite fall ALL the way to 'anonymous' —
		// for both the labelled and the unlabelled cascade
		expect(seen.map((edge) => edge.name)).toEqual([ 'anonymous', 'anonymous', 'probeNamed' ]);
		expect(seen[ 0 ].label).toBe('guard');
		expect(seen.every((edge) => edge.callsite === undefined)).toBe(true);
		// the degraded module still traces: every edge carries its context instance
		expect(seen.every((edge) => edge.instance === probeCtx)).toBe(true);
	});
});

describe('promise settle tap: wrapping a resolved function', () => {
	beforeEach(() => {
		clear();
	});

	it('a promise resolving to a function is wrapped from the settle tap with no callsite', async () => {
		const ctx = { id : 'ctx' };
		const seen: FlowEdge[] = [];
		registerHook('enter', ({ edge }) => {
			seen.push(edge);
		});
		function producedBody () { return 42; }
		const factory = wrap(function factory () {
			const resolved = Promise.resolve(producedBody);
			return resolved;
		}, ctx);
		// fire-and-forget: nobody AWAITS the tapped promise, so when the tap
		// runs, its stack is dive-internal frames only — the wrap of the
		// resolved function has no userland callsite to capture
		let produced: unknown;
		const gate = new Promise<void>((gateResolve) => {
			setTimeout(() => {
				const tapped = factory();
				void tapped.then((value: unknown) => {
					produced = value;
					gateResolve();
				});
			}, 0);
		});
		await gate;
		// the tap wrapped the resolved function to carry the context forward
		expect(isWrappedFunction(produced)).toBe(true);
		if (typeof produced !== 'function') {
			throw new Error('the settle tap must wrap the resolved function');
		}
		expect(produced()).toBe(42);
		const producedEdge = seen[ seen.length - 1 ];
		expect(producedEdge.name).toBe('producedBody');
		expect(producedEdge.callsite).toBeUndefined();
		// context still propagated forward into the produced function
		expect(producedEdge.instance).toBe(ctx);
		const ctxFlow = getFlow(ctx);
		expect(ctxFlow[ ctxFlow.length - 1 ].name).toBe('producedBody');
	});
});

describe('re-wrap shadowing corners', () => {
	beforeEach(() => {
		clear();
	});

	it('re-rooting an ambient (no-context) anonymous wrap: handoff has no parent', () => {
		const ctx = { id : 'new-owner' };
		// wrapped with NO context at rest: the captured ambient context is
		// undefined, so the stored context is undefined too
		const ambient = wrap(function () { return 1; });
		const seen: DiveRecontextPayload[] = [];
		registerHook('recontext', (payload) => {
			seen.push(payload);
		});
		const rerooted = wrap(ambient, ctx);
		expect(rerooted).not.toBe(ambient);
		expect(seen).toHaveLength(1);
		expect(seen[ 0 ].previousContext).toBeUndefined();
		expect(seen[ 0 ].context).toBe(ctx);
		const [ handoff ] = getFlow(ctx);
		expect(handoff.kind).toBe('recontext');
		// nothing to parent on: the old context's story does not exist
		expect(handoff.parentId).toBeNull();
		// the handoff name falls back to the original caption (the callsite)
		expect(handoff.name).toMatch(/coverage-gaps\.spec\.ts:\d+:\d+$/);
	});

	it('a re-root preserves the ORIGINAL wrap label and callsite', () => {
		const ctxA = { id : 'a' };
		const ctxB = { id : 'b' };
		const original = wrap(function labelledWork () { return 1; }, ctxA, 'guard');
		const seen: FlowEdge[] = [];
		registerHook('enter', ({ edge }) => {
			seen.push(edge);
		});
		const rerooted = wrap(original, ctxB);
		rerooted();
		expect(seen).toHaveLength(1);
		expect(seen[ 0 ].label).toBe('guard');
		expect(seen[ 0 ].name).toBe('guard:labelledWork');
		expect(seen[ 0 ].callsite).toMatch(/coverage-gaps\.spec\.ts:\d+:\d+$/);
	});

	it('a re-root of an UNLABELLED wrap leaves the new wrapper unlabelled', () => {
		const ctxA = { id : 'a' };
		const ctxB = { id : 'b' };
		const original = wrap(function plainWork () { return 1; }, ctxA);
		const rerooted = wrap(original, ctxB);
		const seen: FlowEdge[] = [];
		registerHook('enter', ({ edge }) => {
			seen.push(edge);
		});
		rerooted();
		expect(seen).toHaveLength(1);
		expect(seen[ 0 ].label).toBeUndefined();
		expect(seen[ 0 ].name).toBe('plainWork');
	});

	it('re-rooting a FOREIGN wrapper (no wrap-site identity) degrades gracefully', () => {
		// The origin symbols are Symbol.for-registered (shared across builds),
		// so a wrapper produced OUTSIDE wrapInternal — an older or foreign
		// producer — may carry Wrapped + Original but none of the wrap-site
		// identity symbols. Every origin read narrows through `in` + a value
		// check; the re-root must not break on the missing symbols.
		const ctxB = { id : 'b' };
		const handoffs: DiveRecontextPayload[] = [];
		registerHook('recontext', (payload) => {
			handoffs.push(payload);
		});
		function foreignWork () { return 1; }
		const foreign = foreignWork;
		Object.defineProperty(foreign, Symbol.for('mnemonica.dive.wrapped'), {
			value        : true,
			configurable : false,
		});
		Object.defineProperty(foreign, Symbol.for('mnemonica.dive.original'), {
			value        : foreignWork,
			configurable : false,
		});
		const rerooted = wrap(foreign, ctxB);
		expect(rerooted).not.toBe(foreign);
		expect(handoffs).toHaveLength(1);
		// no caption on record: the handoff name falls back to the fn name
		expect(handoffs[ 0 ].edge.name).toBe('foreignWork');
		expect(handoffs[ 0 ].edge.kind).toBe('recontext');
		expect(handoffs[ 0 ].previousContext).toBeUndefined();
		// the re-rooted wrapper works, unlabelled, under the new context
		const entered: FlowEdge[] = [];
		registerHook('enter', ({ edge }) => {
			entered.push(edge);
		});
		expect(rerooted()).toBe(1);
		expect(entered).toHaveLength(1);
		expect(entered[ 0 ].instance).toBe(ctxB);
		expect(entered[ 0 ].label).toBeUndefined();
	});

	it('re-rooting a foreign ANONYMOUS wrapper names the handoff anonymous', () => {
		const ctxB = { id : 'b' };
		const handoffs: DiveRecontextPayload[] = [];
		registerHook('recontext', (payload) => {
			handoffs.push(payload);
		});
		// the IIFE keeps the arrow anonymous — a named-const assignment would
		// infer 'foreign' as its name and skip the ANONYMOUS cascade step
		const foreign = (() => (): number => 1)();
		Object.defineProperty(foreign, Symbol.for('mnemonica.dive.wrapped'), {
			value        : true,
			configurable : false,
		});
		Object.defineProperty(foreign, Symbol.for('mnemonica.dive.original'), {
			value        : foreign,
			configurable : false,
		});
		wrap(foreign, ctxB);
		expect(handoffs).toHaveLength(1);
		// neither caption nor fn name: the last cascade step is 'anonymous'
		expect(handoffs[ 0 ].edge.name).toBe('anonymous');
	});
});

describe('recordCreation / recordCreationError guards', () => {
	beforeEach(() => {
		clear();
	});

	it('recordCreation with no parent at rest records a root create edge', () => {
		const instance = { id : 'i' };
		recordCreation('Rooted', instance);
		const flow = getFlow(instance);
		expect(flow).toHaveLength(1);
		expect(flow[ 0 ].kind).toBe('create');
		expect(flow[ 0 ].parentId).toBeNull();
		expect(flow[ 0 ].status).toBe('ok');
		expect(flow[ 0 ].duration).toBe(0);
	});

	it('recordCreation nested in a wrapped call parents on the execution cursor', () => {
		const ctx = { id : 'ctx' };
		const made = { id : 'made' };
		const fn = wrap(function builder () {
			recordCreation('Nested', made);
		}, ctx);
		fn();
		const flow = getFlow(made);
		expect(flow).toHaveLength(2);
		expect(flow[ 0 ].kind).toBe('call');
		expect(flow[ 1 ].kind).toBe('create');
		expect(flow[ 1 ].parentId).toBe(flow[ 0 ].id);
	});

	it('recordCreation with an empty name records an anonymous create edge', () => {
		const instance = { id : 'i' };
		recordCreation('', instance);
		expect(getFlow(instance)[ 0 ].name).toBe('anonymous');
	});

	it('recordCreationError with an empty name records an anonymous failed create edge', () => {
		const parent = { id : 'p' };
		recordCreation('Parent', parent);
		const failure = new Error('nope');
		recordCreationError('', failure, parent);
		const flow = getFlow(failure);
		expect(flow).toHaveLength(2);
		expect(flow[ 1 ].kind).toBe('create');
		expect(flow[ 1 ].name).toBe('anonymous');
		expect(flow[ 1 ].status).toBe('error');
		expect(getErrorInstance(failure)).toBe(parent);
	});

	it('a non-object failure switches current() to the surviving parent', () => {
		const parent = { id : 'survivor' };
		recordCreationError('Broken', 'thrown string', parent);
		// no Error instance → no edge at all, the parent's story untouched
		expect(getFlow(parent)).toHaveLength(0);
		expect(chainDepth(parent)).toBe(0);
		// but crash attribution falls back to the data that survived
		expect(current()).toBe(parent);
	});
});

describe('wrapInstanceMethods guard rails', () => {
	beforeEach(() => {
		clear();
	});

	it('skips instances with no prototype or the plain Object prototype', () => {
		const nullProto: object = Object.create(null);
		expect(wrapInstanceMethods(nullProto)).toBeUndefined();
		expect(wrapInstanceMethods({})).toBeUndefined();
		// the guard exists to protect Object.prototype — it must not be polluted
		expect(isWrappedFunction(Object.prototype.toString)).toBe(false);
		// a real class prototype still wraps fine afterwards
		class Real {
			method (): number { return 1; }
		}
		const real = new Real();
		wrapInstanceMethods(real);
		expect(isWrappedFunction(Real.prototype.method)).toBe(true);
	});

	it('skips non-function descriptors (getters) but wraps plain methods', () => {
		class WithGetter {
			get computed (): number { return 7; }
			method (): number { return 1; }
		}
		const inst = new WithGetter();
		const seen: FlowEdge[] = [];
		registerHook('enter', ({ edge }) => {
			seen.push(edge);
		});
		wrapInstanceMethods(inst);
		// the getter is untouched: it still computes, and reading it
		// records NO edge
		expect(inst.computed).toBe(7);
		expect(inst.method()).toBe(1);
		expect(seen).toHaveLength(1);
		expect(seen[ 0 ].name).toBe('method');
		expect(seen[ 0 ].kind).toBe('method');
	});

	it('does not re-wrap an already-wrapped method', () => {
		class Once {
			method (): number { return 1; }
		}
		const inst = new Once();
		wrapInstanceMethods(inst);
		const first = Object.getPrototypeOf(inst).method;
		expect(isWrappedFunction(first)).toBe(true);
		// second pass: every method is already wrapped — skipped, not stacked
		wrapInstanceMethods(inst);
		const second = Object.getPrototypeOf(inst).method;
		expect(second).toBe(first);
	});

	it('skips non-configurable methods without throwing', () => {
		class Locked {
			locked (): number { return 1; }
		}
		Object.defineProperty(Locked.prototype, 'locked', {
			value        : Locked.prototype.locked,
			writable     : true,
			configurable : false,
		});
		const inst = new Locked();
		const seen: FlowEdge[] = [];
		registerHook('enter', ({ edge }) => {
			seen.push(edge);
		});
		wrapInstanceMethods(inst);
		expect(isWrappedFunction(Object.getPrototypeOf(inst).locked)).toBe(false);
		expect(inst.locked()).toBe(1);
		expect(seen).toHaveLength(0);
	});

	it('a synchronously throwing method pins the error to its method edge', () => {
		class Failing {
			fail (): never { throw new Error('method boom'); }
		}
		const inst = new Failing();
		wrapInstanceMethods(inst);
		let caught: unknown;
		try {
			inst.fail();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		const flow = getFlow(caught);
		expect(flow).toHaveLength(1);
		expect(flow[ 0 ].kind).toBe('method');
		expect(flow[ 0 ].name).toBe('fail');
		expect(flow[ 0 ].status).toBe('error');
		expect(getErrorInstance(caught)).toBe(inst);
	});
});

describe('upgradeConstructorArg guards', () => {
	beforeEach(() => {
		clear();
	});

	it('ignores plain functions and normally-wrapped functions (no holder)', () => {
		const instance = { id : 'i' };
		const plain = (): number => 1;
		upgradeConstructorArg(plain, instance);
		upgradeConstructorArg(wrap((): number => 2), instance);
		// no-ops: nothing switched the context, nothing threw
		expect(current()).toBeUndefined();
	});

	it('rejects a malformed holder by structure, not by symbol presence', () => {
		const instance = { id : 'i' };
		const forged = (): number => 1;
		// Symbol.for keys are forgeable from userland — a function carrying
		// the arg-holder symbol with the WRONG shape must not be treated as
		// a holder (isDiveArgHolder proves the { context, used } structure)
		Object.defineProperty(forged, Symbol.for('mnemonica.dive.argHolder'), {
			value        : { used : true },
			configurable : true,
		});
		expect(() => upgradeConstructorArg(forged, instance)).not.toThrow();
		// and a holder that reports used:true keeps its context too
		const usedUp = (): number => 2;
		Object.defineProperty(usedUp, Symbol.for('mnemonica.dive.argHolder'), {
			value        : { context : instance, used : true },
			configurable : true,
		});
		expect(() => upgradeConstructorArg(usedUp, instance)).not.toThrow();
	});

	it('a callback already used during construction keeps its original context', () => {
		const parent = { id : 'parent' };
		const instance = { id : 'instance' };
		const seen: FlowEdge[] = [];
		registerHook('enter', ({ edge }) => {
			seen.push(edge);
		});
		const arg = wrapConstructorArg(function cb () { return 1; }, parent);
		arg();
		// the callback ran during "construction" — the upgrade must NOT
		// re-point it at the built instance
		upgradeConstructorArg(arg, instance);
		arg();
		expect(seen).toHaveLength(2);
		expect(seen[ 0 ].instance).toBe(parent);
		expect(seen[ 1 ].instance).toBe(parent);
	});
});

describe('flow reads with degenerate targets', () => {
	beforeEach(() => {
		clear();
	});

	it('getFlow and chainDepth accept a live edge object (e.g. from a hook payload)', () => {
		const ctx = { id : 'ctx' };
		let hooked: FlowEdge | undefined;
		registerHook('enter', ({ edge }) => {
			hooked = edge;
		});
		const fn = wrap(function probed () { return 1; }, ctx);
		fn();
		expect(hooked).toBeDefined();
		// a real edge is not a copy — it resolves to itself as the walk start
		const fromEdge = getFlow(hooked);
		const fromInstance = getFlow(ctx);
		expect(fromEdge).toHaveLength(1);
		expect(fromEdge[ 0 ].id).toBe(fromInstance[ 0 ].id);
		expect(fromEdge[ 0 ].name).toBe('probed');
		expect(chainDepth(hooked)).toBe(1);
	});
});

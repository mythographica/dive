/**
 * The wrap machinery: wrap itself, the per-invocation bookkeeping, context
 * propagation through args/returns/promises, error pinning, and the
 * integration primitives the adapter wiring (@mnemonica/otel's attachHooks)
 * is built from. Every state-touching function takes the acting dive's state
 * as its first parameter.
 */
import {
	FN_NAME,
	KIND_CALL,
	KIND_CONSTRUCT,
	KIND_METHOD,
	KIND_RECONTEXT,
	STATUS_ERROR,
	STATUS_OK,
	SymbolDiveArgHolder,
	SymbolDiveCallsite,
	SymbolDiveCaption,
	SymbolDiveContext,
	SymbolDiveEdge,
	SymbolDiveInstance,
	SymbolDiveLabel,
	SymbolDiveOriginal,
	SymbolDiveWrapped,
	ANONYMOUS,
} from './constants.js';
import {
	Edge,
	isObjectKey,
	recordEdge,
	settleRunning,
} from './store.js';
import type { DiveState } from './state.js';
import {
	emitEnter,
	emitLeave,
	emitRecontext,
	emitSettle,
} from './hooks.js';
import {
	captureCallsite, computeCaption 
} from './callsite.js';
import type {
	AnyFn,
	InstanceSource,
	FlowKind,
	WrappedFn,
} from './types.js';

// A constructor arg wrapped at preCreation carries a MUTABLE context holder so
// postCreation can upgrade an as-yet-unused callback from the parent context to
// the built instance it belongs to. `used` is set the moment it is invoked.
export interface DiveArgHolder { context: object | undefined; used: boolean; }

// The arg-holder shape, proven by structure (Symbol.for keys are `symbol`,
// never `unique symbol` — no interface can key them, so `in` + field checks
// do the narrowing)
const isDiveArgHolder = function (value: unknown): value is DiveArgHolder {
	const matches = typeof value === 'object' && value !== null && 'used' in value && 'context' in value;
	return matches;
};

/**
 * Parentage rule.
 *
 * Depth > 0: we are truly nested inside another wrapped invocation, so the
 * cursor IS the execution parent ("Y called X" is recorded truthfully).
 *
 * Depth === 0: we entered from an unwrapped boundary (timer, emitter, route
 * handler). The cursor may hold a stale edge from an unrelated flow — trusting
 * it would merge two requests into one branch. Instead the edge continues the
 * DATA's own story: the latest edge of the context instance. This is what
 * makes cross-request trace clobbering structurally impossible.
 * The continuation point is an OBJECT held by latestEdges: if it is there,
 * it is alive — never a dangling id, so no fresh-root fallback is needed.
 */
export function executionParent (state: DiveState, context: object | undefined): Edge | null {
	if (state.activeDepth > 0 && state.cursor !== null) {
		return state.cursor;
	}
	if (isObjectKey(context)) {
		const result = state.latestEdges.get(context) ?? null;
		return result;
	}
	return null;
}

/**
 * Pin an error to its trace edge and instance. Every edge the error propagates
 * through is marked 'error', but the error OBJECT is pinned only ONCE: the
 * first (deepest) wrapped boundary wins, so the flight recorder points at the
 * failure site, not at some outer re-throw.
 * The pin is the edge OBJECT (not its id): the Error itself keeps its
 * failing edge alive for as long as the Error lives — an exception filter
 * reading getFlow(error) later never depends on anything else still
 * holding the edge.
 */
export function pinError (state: DiveState, error: unknown, edge: Edge, instance: object | undefined): void {
	// The EDGE records the failure for ANY thrown value — a non-object throw
	// still settles the edge, or it would stay 'running' forever (the running
	// store is the one strong root: an unsettled edge is never collected)
	edge.status = STATUS_ERROR;
	settleRunning(state, edge);
	// The pin needs a carrier — only objects can take the symbol properties
	if (!isObjectKey(error)) {
		return;
	}
	// A non-extensible carrier (a frozen error) cannot take the pin:
	// defineProperty would throw a TypeError that masks the original error
	// on its way out. The edge has already settled 'error' above, so the
	// trace still records the failure — attribution degrades, the user's
	// error never does.
	if (!Object.isExtensible(error)) {
		return;
	}
	if (SymbolDiveEdge in error) {
		return;
	}
	Object.defineProperty(error, SymbolDiveEdge, {
		value        : edge,
		writable     : false,
		enumerable   : false,
		configurable : true,
	});
	if (isObjectKey(instance)) {
		Object.defineProperty(error, SymbolDiveInstance, {
			value        : instance,
			writable     : false,
			enumerable   : false,
			configurable : true,
		});
	}
}

/**
 * Switch the "newest-wins" context behind current(). Integration primitive:
 * adapter-level wiring calls it when a lifecycle event enters an instance's
 * context (e.g. preCreation enters the parent, postCreation the instance).
 * Deliberately NOT used for trace parentage — concurrent flows cannot
 * corrupt the trace through it.
 */
export function enterContext (state: DiveState, instance: object | undefined): void {
	state.lastContext = instance;
}

/**
 * Check if a function is already dive-wrapped. Integration primitive:
 * adapter-level wiring uses it to avoid double-wrapping constructor args.
 * The mark is a process-global Symbol.for key on purpose: wrappedness is a
 * property of the FUNCTION OBJECT, shared by every dive (and by both build
 * flavors) that meets it — see AGENTS.md for the cross-dive rules.
 */
export function isWrappedFunction (value: unknown): boolean {
	if (typeof value !== 'function') {
		return false;
	}
	const result = SymbolDiveWrapped in value;
	return result;
}

/**
 * Tap a promise result so the edge tells the truth about the async work:
 *
 *   - the edge closes ('ok' + full-lifetime duration) when the WHOLE chain
 *     settles. A promise never resolves TO a promise: the runtime flattens
 *     thenables before any .then callback fires (assimilation), so this tap
 *     always sees the final value — a promise returning a promise needs no
 *     wrapping of its own, the tap simply outlives the whole chain;
 *   - a function resolved at the end is wrapped, so context propagates
 *     forward to its future invocations;
 *   - a rejection at ANY depth of the chain propagates here and pins the
 *     error to this edge (deepest-pin wins, see pinError).
 */
export function tapPromise (
	state: DiveState,
	result: Promise<unknown>,
	edge: Edge,
	context: object | undefined,
	started: number
): Promise<unknown> {
	const promiseResult = result.then((resolved: unknown) => {
		edge.status = STATUS_OK;
		settleRunning(state, edge);
		edge.duration = Date.now() - started;
		let settled: unknown = resolved;
		if (typeof resolved === 'function' && !isWrappedFunction(resolved)) {
			const wrappedResult = wrapEntry(state, resolved as WrappedFn, context, true);
			settled = wrappedResult;
		}
		emitSettle(state, edge, settled, undefined);
		return settled;
	}).catch((error: unknown) => {
		pinError(state, error, edge, context);
		emitSettle(state, edge, undefined, error);
		throw error;
	});
	return promiseResult;
}

/**
 * Wrap a function so it restores dive context on invocation AND records the
 * invocation as a trace edge. If no context is provided, captures the current
 * context at wrap time.
 *
 * Re-wrap policy (scope shadowing):
 *   - wrap of an unwrapped fn            → new wrapper, captured context
 *   - wrap of a wrapper, no/same context → idempotent: returned as-is
 *   - wrap of a wrapper, DIFFERENT context → the callback changes ownership:
 *     a 'recontext' handoff edge links the old story to the new one, and a
 *     fresh wrapper around the ORIGINAL fn is bound to the new context
 * Auto-wrap crossings (function args at every wrapped call) never shadow —
 * they are idempotent by design.
 *
 * Handles:
 *   - `new` calls via Reflect.construct (kind: 'construct')
 *   - Returned functions are wrapped to propagate context
 *   - Promise results are tapped (see tapPromise): the edge closes when the
 *     whole chain settles, resolved functions are wrapped, rejections pin
 *     the error to the call's edge
 *
 * Idempotence and shadowing policy behind wrap(). `auto` marks internal
 * crossings (wrapArgs at every wrapped call, constructor-arg invocation
 * reads): those are idempotent only, so a callback that already crossed one
 * flow keeps its story when crossing another — re-rooting is the user's
 * explicit act, never a side effect of passing a function around.
 *
 * The raw public argument pair (contextOrLabel) is normalized HERE, not in a
 * separate wrapper: every hop above captureCallsite is one more dive frame
 * on the wrap-time stack, and the callsite capture pays for each one.
 */
export function wrapEntry<T extends AnyFn> (
	state: DiveState,
	fn: T,
	contextOrLabel: object | string | undefined,
	auto: boolean,
	label?: string
): T {
	const context = typeof contextOrLabel === 'string' ? undefined : contextOrLabel;
	const effectiveLabel = typeof contextOrLabel === 'string' ? contextOrLabel : label;
	if (!isWrappedFunction(fn)) {
		const wrappedResult = wrapInternal(state, fn, context, effectiveLabel);
		return wrappedResult;
	}

	if (auto) {
		return fn;
	}

	// The symbols are Symbol.for-registered (shared across the dual build),
	// so they are `symbol`, never `unique symbol` — no interface can key
	// them. Each read narrows through `in` + a value check instead of
	// casting.
	const storedContext: unknown = SymbolDiveContext in fn ? fn[ SymbolDiveContext ] : undefined;
	const existing = typeof storedContext === 'object' && storedContext !== null ? storedContext : undefined;

	// Explicit wrap with no context or the SAME context: idempotent.
	if (context === undefined || context === existing) {
		return fn;
	}

	// Wrappers without origin info (constructor-arg holders, whose context
	// is a mutable holder by design) cannot be re-rooted this way.
	const storedOriginal: unknown = SymbolDiveOriginal in fn ? fn[ SymbolDiveOriginal ] : undefined;
	// The wrap machinery only ever stores the ORIGINAL fn (a T) here —
	// the typeof check is the runtime proof, the `as T` the generic
	// re-grounding TS cannot derive
	const original = typeof storedOriginal === 'function' ? storedOriginal as T : undefined;
	if (original === undefined) {
		return fn;
	}

	const storedCaption: unknown = SymbolDiveCaption in fn ? fn[ SymbolDiveCaption ] : undefined;
	const caption = typeof storedCaption === 'string' ? storedCaption : undefined;
	recordHandoff(state, original, existing, context, caption);
	// The re-root preserves the ORIGINAL site's label/callsite: a bulb's
	// identity is where it was first wrapped, not where it was re-rooted.
	const storedLabel: unknown = SymbolDiveLabel in fn ? fn[ SymbolDiveLabel ] : undefined;
	const originLabel = typeof storedLabel === 'string' ? storedLabel : undefined;
	const storedCallsite: unknown = SymbolDiveCallsite in fn ? fn[ SymbolDiveCallsite ] : undefined;
	const originCallsite = typeof storedCallsite === 'string' ? storedCallsite : undefined;
	const result = wrapInternal(
		state,
		original,
		context,
		effectiveLabel ?? originLabel,
		originCallsite
	);
	return result;
}

/**
 * Record the ownership transfer of a re-rooted callback: a 'recontext'
 * edge on the NEW context, parented on the OLD context's latest retained
 * edge. Later invocations of the new wrapper continue from this edge via
 * latestEdge, so getFlow walks backward across the re-root into the
 * previous flow.
 */
export function recordHandoff (
	state: DiveState,
	fn: AnyFn,
	previousContext: object | undefined,
	context: object | undefined,
	caption?: string
): void {
	const parent = isObjectKey(previousContext) ? state.latestEdges.get(previousContext) ?? null : null;
	const name = caption || fn.name || ANONYMOUS;
	const edge = recordEdge(state, KIND_RECONTEXT, name, context, parent);
	// The context arrives as an argument — attribution is never ambient here
	if (isObjectKey(context)) {
		edge.instanceSource = 'explicit';
	}
	emitRecontext(state, edge, fn, previousContext, context);
}

/**
 * The per-invocation machinery shared by wrapInternal's wrapper and
 * wrapInstanceMethods' wrappedMethod: save/restore cursor + context,
 * record the edge, wrap the args (context propagates DOWN), invoke,
 * propagate the context FORWARD (returned functions wrapped, promises
 * tapped), pin errors, emit enter/leave, restore. What varies arrives as
 * the spec: kind/name/context/callsite/source, the raw args, and `invoke`
 * (the construct-vs-call step — new.target and `this` only exist in the
 * caller's frame).
 */
export interface WrappedInvocationSpec {
	kind      : FlowKind;
	name      : string;
	context   : object | undefined;
	// The wrap-time label/callsite, set on the edge when present (methods
	// carry neither)
	label     : string | undefined;
	callsite  : string | undefined;
	source    : InstanceSource;
	args      : unknown[];
	invoke    : (wrappedArgs: unknown[]) => unknown;
}

export function runWrappedInvocation (state: DiveState, spec: WrappedInvocationSpec): unknown {
	const previousContext = state.lastContext;
	const previousCursor = state.cursor;
	state.lastContext = spec.context;

	const edge = recordEdge(state, spec.kind, spec.name, spec.context, executionParent(state, spec.context));
	if (spec.label !== undefined) {
		edge.label = spec.label;
	}
	if (spec.callsite) {
		edge.callsite = spec.callsite;
	}
	if (spec.context !== undefined) {
		edge.instanceSource = spec.source;
	}
	state.cursor = edge;
	emitEnter(state, edge, spec.args);
	state.activeDepth = state.activeDepth + 1;

	const started = edge.ts;
	let produced: unknown;
	// The catch records and FALLS THROUGH; the rethrow lives at the end of
	// the finally (a boolean flag, not the value — userland may throw
	// undefined). A catch that always rethrows leaves the try statement's
	// "catch completes normally" arm unreachable forever; falling through
	// keeps every arm of the statement reachable. The finally runs before
	// the caller sees the error either way, so the caller-visible semantics
	// are identical to `throw` inside the catch.
	let thrown = false;
	let thrownValue: unknown = undefined;
	try {
		// Wrap function args with the captured context so context propagates
		// DOWN through nested callbacks (args of args). Because each wrapped
		// arg is itself a wrapped function that does this too, the propagation
		// chains to any depth. Already-wrapped args are left as-is.
		const wrappedArgs = wrapArgs(state, spec.args, spec.context);

		let result: unknown = spec.invoke(wrappedArgs);

		// Wrap returned functions so they carry the context forward
		if (typeof result === 'function' && !isWrappedFunction(result)) {
			result = wrapEntry(state, result as WrappedFn, spec.context, true);
		}

		// If Promise: tap it — the edge closes ('ok' + full-lifetime
		// duration) when the whole chain settles; resolved functions are
		// wrapped to carry context forward; rejections pin to this edge.
		if (result instanceof Promise) {
			const promiseResult = tapPromise(state, result, edge, spec.context, started);
			produced = promiseResult;
			return promiseResult;
		}

		edge.status = STATUS_OK;
		settleRunning(state, edge);
		produced = result;
		return result;
	} catch (error: unknown) {
		thrown = true;
		thrownValue = error;
		pinError(state, error, edge, spec.context);
	} finally {
		edge.duration = Date.now() - started;
		emitLeave(state, edge, produced);
		state.cursor = previousCursor;
		state.activeDepth = state.activeDepth - 1;
		state.lastContext = previousContext;
		if (thrown) {
			throw thrownValue;
		}
	}
}

/**
 * The actual wrapper construction behind wrapEntry: capture the context,
 * record each invocation as an edge, propagate context through args,
 * returned functions and promise chains, pin errors to the edge.
 */
export function wrapInternal<T extends AnyFn> (
	state: DiveState,
	fn: T,
	context: object | undefined,
	label?: string,
	callsiteOverride?: string
): T {
	const capturedContext = context ?? state.lastContext;
	// Provenance, decided at wrap time: an explicitly passed context is trusted;
	// the lastContext fallback is newest-wins ambient — truthful only for
	// fully-instrumented synchronous flows
	const capturedSource: InstanceSource = context !== undefined ? 'explicit' : 'ambient';
	const callsite = callsiteOverride ?? captureCallsite();
	const caption = computeCaption(fn, label, callsite);

	const wrapped = function (this: unknown, ...args: never[]) {
		const isConstructor = new.target !== undefined;
		const produced = runWrappedInvocation(state, {
			kind    : isConstructor ? KIND_CONSTRUCT : KIND_CALL,
			name    : caption,
			context : capturedContext,
			label,
			callsite,
			source  : capturedSource,
			args,
			// new.target and `this` are this frame's — the construct/call
			// step cannot leave it
			invoke  : (wrappedArgs: unknown[]): unknown => {
				if (isConstructor) {
					// AnyFn is assignable to Reflect.construct's Function
					// target — no cast; the runtime fn IS constructible here
					const constructed: unknown = Reflect.construct(fn, wrappedArgs, new.target);
					return constructed;
				}
				const called: unknown = Reflect.apply(fn, this, wrappedArgs);
				return called;
			},
		});
		return produced;
	} as T;

	// Preserve prototype for constructor wrapping
	Object.setPrototypeOf(wrapped, fn);
	wrapped.prototype = fn.prototype;

	Object.defineProperty(wrapped, FN_NAME, {
		value        : `diveWrapped:${caption}`,
		configurable : true,
	});

	Object.defineProperty(wrapped, SymbolDiveWrapped, {
		value        : true,
		configurable : false,
		enumerable   : false,
	});

	// Origin info for re-wrap shadowing (see wrapEntry).
	Object.defineProperty(wrapped, SymbolDiveOriginal, {
		value        : fn,
		configurable : false,
		enumerable   : false,
	});

	Object.defineProperty(wrapped, SymbolDiveContext, {
		value        : capturedContext,
		configurable : false,
		enumerable   : false,
	});

	// Wrap-site identity for re-root preservation and tooling introspection
	Object.defineProperty(wrapped, SymbolDiveCallsite, {
		value        : callsite,
		configurable : false,
		enumerable   : false,
	});

	Object.defineProperty(wrapped, SymbolDiveLabel, {
		value        : label,
		configurable : false,
		enumerable   : false,
	});

	Object.defineProperty(wrapped, SymbolDiveCaption, {
		value        : caption,
		configurable : false,
		enumerable   : false,
	});

	return wrapped;
}

/**
 * Auto-wrap function arguments in an array. Internal: used by wrap() and by
 * wrapInstanceMethods(); not part of the public API.
 */
export function wrapArgs (
	state: DiveState,
	args: unknown[],
	context?: object
): unknown[] {
	const result = args.map((arg) => {
		if (typeof arg === 'function') {
			const wrappedArg = wrapEntry(state, arg as WrappedFn, context, true);
			return wrappedArg;
		}
		return arg;
	});
	return result;
}

/**
 * Wrap a constructor argument with an UPGRADEABLE context. Integration
 * primitive — the adapter-level wiring calls it from preCreation.
 *
 * At preCreation the built instance does not exist yet, so the callback is bound
 * to the parent (existentInstance) via a mutable holder. If it is never invoked
 * during construction, postCreation upgrades the holder to the built instance
 * (see upgradeConstructorArg) — so a callback stored for later use resolves to
 * the instance it belongs to, not its parent. Once invoked, the context is
 * locked (`used`), and later calls keep whatever it ran with.
 *
 * Delegates the actual call to wrap() so it inherits the trace recording and
 * returned-function / promise propagation, reading the holder's CURRENT context
 * each time.
 */
export function wrapConstructorArg (
	state: DiveState,
	fn: AnyFn,
	context: object | undefined
): AnyFn {
	const holder: DiveArgHolder = {
		context,
		used : false,
	};

	const wrapped = function (this: unknown, ...args: unknown[]) {
		holder.used = true;
		const wrappedCall = wrapEntry(state, fn, holder.context, true);
		// Reflect.apply's return is `any` in the lib types — pin it to unknown
		const result: unknown = Reflect.apply(wrappedCall, this, args);
		return result;
	};

	Object.defineProperty(wrapped, SymbolDiveWrapped, {
		value : true, configurable : false, enumerable : false,
	});
	Object.defineProperty(wrapped, SymbolDiveArgHolder, {
		value : holder, configurable : false, enumerable : false,
	});

	return wrapped;
}

/**
 * Upgrade an as-yet-unused constructor-arg callback to the built instance.
 * Integration primitive — the adapter-level wiring calls it from postCreation.
 * No-op for non-wrapped args, or callbacks already invoked during construction.
 * State-free: the holder is self-contained, so any dive (or build flavor)
 * may perform the upgrade.
 */
export function upgradeConstructorArg (arg: unknown, instance: object): void {
	if (typeof arg !== 'function') {
		return;
	}
	const storedHolder: unknown = SymbolDiveArgHolder in arg ? arg[ SymbolDiveArgHolder ] : undefined;
	const holder = isDiveArgHolder(storedHolder) ? storedHolder : undefined;
	if (holder && !holder.used) {
		holder.context = instance;
	}
}

/**
 * Wrap user-defined methods so they run with the receiving instance as the
 * active dive context AND record each call as a 'method' edge.
 * Integration primitive — the adapter-level wiring calls it from postCreation.
 *
 * Wrapping is applied to the instance's immediate PROTOTYPE (not the instance
 * itself), using `this` (the receiver) as the context. For plain classes —
 * where many instances share one prototype — this wraps each method ONCE
 * instead of once per instance. NOTE: mnemonica gives every instance its own
 * immediate prototype, so for mnemonica instances this is still per-instance
 * (no shared prototype exists to wrap once); it is not worse, just not a win.
 * See AGENTS.md "Internals".
 *
 * Wrapped methods also:
 *   - wrap function arguments to propagate context
 *   - wrap function return values
 *   - pin errors (sync throws and promise rejections) to the call's edge
 */
export function wrapInstanceMethods (state: DiveState, instance: object): void {
	const proto = Object.getPrototypeOf(instance);
	if (!proto || proto === Object.prototype) {
		return;
	}

	const descriptors = Object.getOwnPropertyDescriptors(proto);

	for (const [ name, descriptor ] of Object.entries(descriptors)) {
		if (name === 'constructor') {
			continue;
		}
		if (typeof descriptor.value !== 'function') {
			continue;
		}
		if (isWrappedFunction(descriptor.value)) {
			continue;
		}
		// Only a configurable method can be safely redefined on the prototype.
		if (descriptor.configurable === false) {
			continue;
		}

		const fn = descriptor.value as WrappedFn;

		const wrappedMethod = function (this: object, ...args: unknown[]) {
			const context = this;
			const produced = runWrappedInvocation(state, {
				kind     : KIND_METHOD,
				name,
				context,
				label    : undefined,
				callsite : undefined,
				// The receiver IS the context — never ambient
				source   : 'explicit',
				args,
				invoke   : (wrappedArgs: unknown[]): unknown => {
					const called: unknown = fn.apply(this, wrappedArgs);
					return called;
				},
			});
			return produced;
		};

		// Mark so a shared prototype is not re-wrapped by the next instance.
		Object.defineProperty(wrappedMethod, SymbolDiveWrapped, {
			value        : true,
			configurable : false,
			enumerable   : false,
		});

		Object.defineProperty(proto, name, {
			value        : wrappedMethod,
			writable     : true,
			configurable : true,
			enumerable   : false,
		});
	}
}

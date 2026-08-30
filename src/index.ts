/**
 * @mnemonica/dive — Data + Flow for userland instances.
 *
 * The Goal: uncaughtException / unhandledRejection never know where they came
 * from or WHICH DATA caused them. Dive answers it: context is pinned to
 * userland instances (Data), and every wrapped invocation appends an edge to a
 * bounded trace (Flow). When the Data Flow fails, the error is pinned to its
 * deepest trace edge — so the error carries both the data and the flow that
 * happened to it. No AsyncLocalStorage, no async_hooks.
 *
 * Dive is framework- and library-agnostic: it imports nothing at all.
 * The mnemonica hook wiring (attachHooks) lives in @mnemonica/nestjs — dive
 * only exports the primitives that wiring is built from.
 *
 * Public API:
 *   dive.wrap(fn, context?)       → capture context now, restore + record at invocation
 *   dive.current()                → the instance executing right now
 *   dive.getFlow(target?)         → execution branch: Error | instance | current cursor
 *   dive.getTrace()               → the whole retained trace (copies), oldest first
 *   dive.getErrorInstance(error)  → the data pinned to an error
 *   dive.setTraceLimit(n)         → ring-buffer size for the trace (0 disables recording)
 *   dive.registerHook(event, cb)  → subscribe to edge lifecycle: enter | leave | settle | recontext | create
 *   dive.unregisterHook(ev, cb)   → detach an exact subscriber by reference
 *   dive.clear()                  → reset everything (testing)
 *
 * Integration primitives (for adapter-level wiring, e.g. @mnemonica/nestjs):
 *   dive.enterContext(instance)        → switch the current() context
 *   dive.wrapConstructorArg(fn, ctx)   → wrap a constructor arg, upgradeable context
 *   dive.upgradeConstructorArg(arg, i) → upgrade an unused arg callback to the instance
 *   dive.wrapInstanceMethods(instance) → wrap the instance's prototype methods
 *   dive.recordCreation(name, i, p?)   → 'create' edge under data-flow parentage
 *   dive.recordCreationError(n, e, p?) → failed 'create' edge + error pinning
 *   dive.isWrappedFunction(fn)         → is this function already dive-wrapped?
 *
 * Internals:
 *   - edges: Map<id, FlowEdge> ring buffer (oldest evicted past traceLimit)
 *   - cursor: id of the edge executing right now; null at rest
 *   - activeDepth: how deep we are inside wrapped invocations; depth > 0 means
 *     the cursor is a truthful execution parent, depth === 0 means we entered
 *     from an unwrapped boundary (timer, emitter, route handler) and parentage
 *     must come from the DATA (latestEdge of the context instance)
 *   - latestEdge: WeakMap<instance, edgeId> — each instance's most recent edge,
 *     so construction and method calls continue the instance's own story
 *   - lastContext: the "newest-wins" switcher behind current(); deliberately
 *     NOT used for trace parentage, so concurrent flows cannot corrupt the trace
 */

const SymbolDiveInstance = Symbol.for('mnemonica.dive.instance');
const SymbolDiveEdge = Symbol.for('mnemonica.dive.edge');
const SymbolDiveWrapped = Symbol.for('mnemonica.dive.wrapped');
const SymbolDiveArgHolder = Symbol.for('mnemonica.dive.argHolder');
// Origin info installed on every wrap() wrapper: the ORIGINAL fn and the
// captured context. This is what makes re-wrap shadowing possible — a
// wrapper always knows what it wraps and whose story it tells.
const SymbolDiveOriginal = Symbol.for('mnemonica.dive.original');
const SymbolDiveContext = Symbol.for('mnemonica.dive.context');

// The domain vocabulary, defined once — a single source of truth for every
// status, kind, and fallback name the trace can carry.
const STATUS_RUNNING = 'running';
const STATUS_OK = 'ok';
const STATUS_ERROR = 'error';
const KIND_CREATE = 'create';
const KIND_CALL = 'call';
const KIND_CONSTRUCT = 'construct';
const KIND_METHOD = 'method';
const KIND_RECONTEXT = 'recontext';
const ANONYMOUS = 'anonymous';
const FN_NAME = 'name';

export type FlowKind = 'create' | 'call' | 'construct' | 'method' | 'recontext';
export type FlowStatus = 'running' | 'ok' | 'error';

export interface FlowEdge {
	id       : number;
	parentId : number | null;
	instance : object | undefined;
	name     : string;
	kind     : FlowKind;
	ts       : number;
	duration : number | undefined;
	status   : FlowStatus;
}

// A constructor arg wrapped at preCreation carries a MUTABLE context holder so
// postCreation can upgrade an as-yet-unused callback from the parent context to
// the built instance it belongs to. `used` is set the moment it is invoked.
interface DiveArgHolder { context: object | undefined; used: boolean; }

/**
 * Edge lifecycle hooks — dive PUBLISHES its ground truth (emission, never
 * ingestion). ALS/OTel vendors subscribe and correlate from THEIR side at the
 * one moment both trees share a frame; dive never imports async_hooks and
 * never trusts external propagation.
 *
 *   enter     — right after the edge is recorded, while cursor and lastContext
 *               hold the truthful values. Payload: the fresh edge object ITSELF
 *               (subscribers may attach their own symbols to it — span ids give
 *               the reverse join for free) plus the invocation args by reference.
 *   leave     — the sync close, with the edge's final status/duration and what
 *               the wrap produced (plain value / wrapped function / tapped
 *               promise; undefined when the call threw).
 *   settle    — when a tapped promise chain closes. Distinct from leave so
 *               "the sync head returned" is never confused with "the work is
 *               done": result on resolution, error on rejection.
 *   recontext — a re-wrap handoff: the callback changed ownership, payload
 *               links the old context's story to the new one.
 *   create    — OPT-IN, off the default four: a construction edge recorded
 *               via recordCreation/recordCreationError. Deliberately NOT an
 *               'enter' — that lifecycle is the adapter's own mnemonica-hook
 *               domain, and re-publishing it as enter would double-report
 *               there. A distinct event lets a third-party subscriber (one
 *               that is NOT the adapter — e.g. the strategy trace-push
 *               channel) follow constructions without touching the adapter
 *               contract. error is set on the recordCreationError path.
 *
 * Hooks fire only when an edge is recorded: with traceLimit 0 there is nothing
 * to observe and no event fires. Dispatch cost when unsubscribed is one length
 * check per edge; subscriber exceptions are contained per-subscriber — a
 * throwing hook degrades its own observability, never the trace.
 */
export type DiveHookEvent = 'enter' | 'leave' | 'settle' | 'recontext' | 'create';

export interface DiveEnterPayload {
	edge : FlowEdge;
	args : unknown[];
}

export interface DiveLeavePayload {
	edge   : FlowEdge;
	result : unknown;
}

export interface DiveSettlePayload {
	edge   : FlowEdge;
	result : unknown;
	error  : unknown;
}

export interface DiveRecontextPayload {
	edge            : FlowEdge;
	fn              : (...args: unknown[]) => unknown;
	previousContext : object | undefined;
	context         : object | undefined;
}

export interface DiveCreatePayload {
	edge  : FlowEdge;
	error : unknown;
}

export type DiveHookPayload =
	DiveEnterPayload | DiveLeavePayload | DiveSettlePayload | DiveRecontextPayload | DiveCreatePayload;

type DiveHook<P> = (payload: P) => void;

const hooks: Record<DiveHookEvent, Array<DiveHook<DiveHookPayload>>> = {
	enter     : [],
	leave     : [],
	settle    : [],
	recontext : [],
	create    : [],
};

/**
 * Subscribe to an edge lifecycle event. Returns an unregister function.
 * Same shape and philosophy as mnemonica's own registerHook.
 */
export function registerHook (event: 'enter', hook: DiveHook<DiveEnterPayload>): () => void;
export function registerHook (event: 'leave', hook: DiveHook<DiveLeavePayload>): () => void;
export function registerHook (event: 'settle', hook: DiveHook<DiveSettlePayload>): () => void;
export function registerHook (event: 'recontext', hook: DiveHook<DiveRecontextPayload>): () => void;
export function registerHook (event: 'create', hook: DiveHook<DiveCreatePayload>): () => void;
export function registerHook (event: DiveHookEvent, hook: (...args: never[]) => void): () => void {
	const subscribers = hooks[event];
	// The public overloads narrow the payload per event; internally every
	// subscriber is stored against the union and dispatched within its own try.
	const stored = hook as DiveHook<DiveHookPayload>;
	subscribers.push(stored);
	const unregister = (): void => {
		detachHook(event, stored);
	};
	return unregister;
}

function detachHook (event: DiveHookEvent, hook: DiveHook<DiveHookPayload>): void {
	const subscribers = hooks[event];
	const at = subscribers.indexOf(hook);
	if (at !== -1) {
		subscribers.splice(at, 1);
	}
}

/**
 * Detach an exact subscriber by reference — for when the unregister closure
 * returned by registerHook was not kept. No-op for unknown hooks.
 */
export function unregisterHook (event: 'enter', hook: DiveHook<DiveEnterPayload>): void;
export function unregisterHook (event: 'leave', hook: DiveHook<DiveLeavePayload>): void;
export function unregisterHook (event: 'settle', hook: DiveHook<DiveSettlePayload>): void;
export function unregisterHook (event: 'recontext', hook: DiveHook<DiveRecontextPayload>): void;
export function unregisterHook (event: 'create', hook: DiveHook<DiveCreatePayload>): void;
export function unregisterHook (event: DiveHookEvent, hook: (...args: never[]) => void): void {
	const stored = hook as DiveHook<DiveHookPayload>;
	detachHook(event, stored);
}

/**
 * Contained dispatch: every subscriber runs inside its own try, so a throwing
 * hook degrades its own observability and never corrupts the edge, the result,
 * or user code.
 */
function dispatchHook (subscribers: Array<DiveHook<DiveHookPayload>>, payload: DiveHookPayload): void {
	for (const subscriber of subscribers) {
		try {
			subscriber(payload);
		} catch {
			// a throwing subscriber degrades its own observability, never the trace
		}
	}
}

function emitEnter (edge: FlowEdge, args: unknown[]): void {
	const subscribers = hooks.enter;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveEnterPayload = { edge, args };
	dispatchHook(subscribers, payload);
}

function emitLeave (edge: FlowEdge, result: unknown): void {
	const subscribers = hooks.leave;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveLeavePayload = { edge, result };
	dispatchHook(subscribers, payload);
}

function emitSettle (edge: FlowEdge, result: unknown, error: unknown): void {
	const subscribers = hooks.settle;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveSettlePayload = { edge, result, error };
	dispatchHook(subscribers, payload);
}

function emitRecontext (
	edge: FlowEdge,
	fn: (...args: unknown[]) => unknown,
	previousContext: object | undefined,
	context: object | undefined
): void {
	const subscribers = hooks.recontext;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveRecontextPayload = { edge, fn, previousContext, context };
	dispatchHook(subscribers, payload);
}

function emitCreate (edge: FlowEdge, error: unknown): void {
	const subscribers = hooks.create;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveCreatePayload = { edge, error };
	dispatchHook(subscribers, payload);
}


let edges = new Map<number, FlowEdge>();
let latestEdge = new WeakMap<object, number>();
let nextEdgeId = 1;
let traceLimit = 1024;
let cursor: number | null = null;
let activeDepth = 0;
let lastContext: object | undefined;

function isObjectKey (value: unknown): value is object {
	return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * Append an edge to the trace. Evicts the oldest edges past traceLimit.
 * Returns undefined when recording is disabled (traceLimit === 0).
 */
function recordEdge (
	kind: FlowKind,
	name: string,
	instance: object | undefined,
	parentId: number | null
): FlowEdge | undefined {
	if (traceLimit === 0) {
		return undefined;
	}
	const edge: FlowEdge = {
		id       : nextEdgeId++,
		parentId,
		instance,
		name,
		kind,
		ts       : Date.now(),
		duration : undefined,
		status   : STATUS_RUNNING,
	};
	edges.set(edge.id, edge);
	while (edges.size > traceLimit) {
		const oldest = edges.keys().next();
		if (oldest.done) {
			break;
		}
		edges.delete(oldest.value);
	}
	if (isObjectKey(instance)) {
		latestEdge.set(instance, edge.id);
	}
	return edge;
}

/**
 * Parentage rule — the heart of the redesign.
 *
 * Depth > 0: we are truly nested inside another wrapped invocation, so the
 * cursor IS the execution parent ("Y called X" is recorded truthfully).
 *
 * Depth === 0: we entered from an unwrapped boundary (timer, emitter, route
 * handler). The cursor may hold a stale edge from an unrelated flow — trusting
 * it would merge two requests into one branch. Instead the edge continues the
 * DATA's own story: the latest edge of the context instance. This is what
 * makes cross-request trace clobbering structurally impossible.
 */
function executionParent (context: object | undefined): number | null {
	if (activeDepth > 0 && cursor !== null) {
		return cursor;
	}
	if (isObjectKey(context)) {
		const own = latestEdge.get(context);
		// The instance's latest edge may have been evicted from the ring
		// buffer; parenting onto a dangling id would claim a story nobody
		// retained. A forgotten continuation point is a fresh root.
		const result = own !== undefined && edges.has(own) ? own : null;
		return result;
	}
	return null;
}

/**
 * Pin an error to its trace edge and instance. Every edge the error propagates
 * through is marked 'error', but the error OBJECT is pinned only ONCE: the
 * first (deepest) wrapped boundary wins, so the flight recorder points at the
 * failure site, not at some outer re-throw.
 */
function pinError (error: unknown, edge: FlowEdge | undefined, instance: object | undefined): void {
	if (!isObjectKey(error)) {
		return;
	}
	if (edge) {
		edge.status = STATUS_ERROR;
	}
	if (SymbolDiveEdge in (error as Record<symbol, unknown>)) {
		return;
	}
	if (edge) {
		Object.defineProperty(error, SymbolDiveEdge, {
			value        : edge.id,
			writable     : false,
			enumerable   : false,
			configurable : true,
		});
	}
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
export function enterContext (instance: object | undefined): void {
	lastContext = instance;
}

/**
 * Check if a function is already dive-wrapped. Integration primitive:
 * adapter-level wiring uses it to avoid double-wrapping constructor args.
 */
export function isWrappedFunction (value: unknown): boolean {
	return typeof value === 'function' && SymbolDiveWrapped in (value as unknown as Record<symbol, unknown>);
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
function tapPromise (
	result: Promise<unknown>,
	edge: FlowEdge | undefined,
	context: object | undefined,
	started: number
): Promise<unknown> {
	const promiseResult = result.then((resolved: unknown) => {
		if (edge) {
			edge.status = STATUS_OK;
			edge.duration = Date.now() - started;
		}
		let settled: unknown = resolved;
		if (typeof resolved === 'function' && !isWrappedFunction(resolved)) {
			const wrappedResult = wrapEntry(resolved as (...args: unknown[]) => unknown, context, true);
			settled = wrappedResult;
		}
		if (edge) {
			emitSettle(edge, settled, undefined);
		}
		return settled;
	}).catch((error: unknown) => {
		pinError(error, edge, context);
		if (edge) {
			emitSettle(edge, undefined, error);
		}
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
 */
export function wrap<T extends (...args: unknown[]) => unknown> (
	fn: T,
	context?: object
): T {
	const result = wrapEntry(fn, context, false);
	return result;
}

/**
 * Idempotence and shadowing policy behind wrap(). `auto` marks internal
 * crossings (wrapArgs at every wrapped call, constructor-arg invocation
 * reads): those are idempotent only, so a callback that already crossed one
 * flow keeps its story when crossing another — re-rooting is the user's
 * explicit act, never a side effect of passing a function around.
 */
function wrapEntry<T extends (...args: unknown[]) => unknown> (
	fn: T,
	context: object | undefined,
	auto: boolean
): T {
	if (!isWrappedFunction(fn)) {
		const result = wrapInternal(fn, context);
		return result;
	}

	if (auto) {
		return fn;
	}

	const existing = (fn as unknown as Record<symbol, unknown>)[SymbolDiveContext] as object | undefined;

	// Explicit wrap with no context or the SAME context: idempotent.
	if (context === undefined || context === existing) {
		return fn;
	}

	// Wrappers without origin info (constructor-arg holders, whose context
	// is a mutable holder by design) cannot be re-rooted this way.
	const original = (fn as unknown as Record<symbol, unknown>)[SymbolDiveOriginal] as T | undefined;
	if (original === undefined) {
		return fn;
	}

	recordHandoff(original, existing, context);
	const result = wrapInternal(original, context);
	return result;
}

/**
 * Record the ownership transfer of a re-rooted callback: a 'recontext'
 * edge on the NEW context, parented on the OLD context's latest retained
 * edge. Later invocations of the new wrapper continue from this edge via
 * latestEdge, so getFlow walks backward across the re-root into the
 * previous flow.
 */
function recordHandoff (
	fn: (...args: unknown[]) => unknown,
	previousContext: object | undefined,
	context: object | undefined
): void {
	let parentId: number | null = null;
	if (isObjectKey(previousContext)) {
		const own = latestEdge.get(previousContext);
		parentId = own !== undefined && edges.has(own) ? own : null;
	}
	const name = (fn as { name?: string }).name || ANONYMOUS;
	const edge = recordEdge(KIND_RECONTEXT, name, context, parentId);
	if (edge) {
		emitRecontext(edge, fn, previousContext, context);
	}
}

/**
 * The actual wrapper construction behind wrapEntry: capture the context,
 * record each invocation as an edge, propagate context through args,
 * returned functions and promise chains, pin errors to the edge.
 */
function wrapInternal<T extends (...args: unknown[]) => unknown> (
	fn: T,
	context: object | undefined
): T {
	const capturedContext = context ?? lastContext;

	const wrapped = function (this: unknown, ...args: unknown[]) {
		const isConstructor = new.target !== undefined;
		const previousContext = lastContext;
		const previousCursor = cursor;
		lastContext = capturedContext;

		const edge = recordEdge(
			isConstructor ? KIND_CONSTRUCT : KIND_CALL,
			(fn as { name?: string }).name || ANONYMOUS,
			capturedContext,
			executionParent(capturedContext)
		);
		if (edge) {
			cursor = edge.id;
			emitEnter(edge, args);
		}
		activeDepth++;

		const started = edge ? edge.ts : 0;
		let produced: unknown;
		try {
			// Wrap function args with the captured context so context propagates
			// DOWN through nested callbacks (args of args). Because each wrapped
			// arg is itself a wrapped function that does this too, the propagation
			// chains to any depth. Already-wrapped args are left as-is.
			const wrappedArgs = wrapArgs(args, capturedContext);

			let result: unknown;
			if (isConstructor) {
				result = Reflect.construct(
					fn as unknown as new (...args: unknown[]) => unknown,
					wrappedArgs,
					new.target
				);
			} else {
				result = fn.apply(this, wrappedArgs);
			}

			// Wrap returned functions so they carry the context forward
			if (typeof result === 'function' && !isWrappedFunction(result)) {
				result = wrapEntry(result as (...args: unknown[]) => unknown, capturedContext, true);
			}

			// If Promise: tap it — the edge closes ('ok' + full-lifetime
			// duration) when the whole chain settles; resolved functions are
			// wrapped to carry context forward; rejections pin to this edge.
			if (result instanceof Promise) {
				const promiseResult = tapPromise(result, edge, capturedContext, started);
				produced = promiseResult;
				return promiseResult;
			}

			if (edge) {
				edge.status = STATUS_OK;
			}
			produced = result;
			return result;
		} catch (error: unknown) {
			pinError(error, edge, capturedContext);
			throw error;
		} finally {
			if (edge) {
				edge.duration = Date.now() - started;
				emitLeave(edge, produced);
			}
			cursor = previousCursor;
			activeDepth--;
			lastContext = previousContext;
		}
	} as T;

	// Preserve prototype for constructor wrapping
	Object.setPrototypeOf(wrapped, fn);
	wrapped.prototype = fn.prototype;

	Object.defineProperty(wrapped, FN_NAME, {
		value        : `diveWrapped:${(fn as { name?: string }).name}`,
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

	return wrapped;
}

/**
 * Auto-wrap function arguments in an array. Internal: used by wrap() and by
 * wrapInstanceMethods(); not part of the public API.
 */
function wrapArgs (
	args: unknown[],
	context?: object
): unknown[] {
	return args.map((arg) => {
		if (typeof arg === 'function') {
			const result = wrapEntry(arg as (...args: unknown[]) => unknown, context, true);
			return result;
		}
		return arg;
	});
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
	fn: (...args: unknown[]) => unknown,
	context: object | undefined
): (...args: unknown[]) => unknown {
	const holder: DiveArgHolder = {
		context,
		used : false,
	};

	const wrapped = function (this: unknown, ...args: unknown[]) {
		holder.used = true;
		const wrappedCall = wrapEntry(fn, holder.context, true);
		const result = wrappedCall.apply(this, args);
		return result;
	} as (...args: unknown[]) => unknown;

	Object.defineProperty(wrapped, SymbolDiveWrapped, {
		value: true, configurable: false, enumerable: false,
	});
	Object.defineProperty(wrapped, SymbolDiveArgHolder, {
		value: holder, configurable: false, enumerable: false,
	});

	return wrapped;
}

/**
 * Upgrade an as-yet-unused constructor-arg callback to the built instance.
 * Integration primitive — the adapter-level wiring calls it from postCreation.
 * No-op for non-wrapped args, or callbacks already invoked during construction.
 */
export function upgradeConstructorArg (arg: unknown, instance: object): void {
	if (typeof arg !== 'function') {
		return;
	}
	const holder = (arg as unknown as Record<symbol, unknown>)[SymbolDiveArgHolder] as DiveArgHolder | undefined;
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
 * See README "Internals".
 *
 * Wrapped methods also:
 *   - wrap function arguments to propagate context
 *   - wrap function return values
 *   - pin errors (sync throws and promise rejections) to the call's edge
 */
export function wrapInstanceMethods (instance: object): void {
	const proto = Object.getPrototypeOf(instance);
	if (!proto || proto === Object.prototype) {
		return;
	}

	const descriptors = Object.getOwnPropertyDescriptors(proto);

	for (const [name, descriptor] of Object.entries(descriptors)) {
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

		const fn = descriptor.value as (...args: unknown[]) => unknown;

		const wrappedMethod = function (this: object, ...args: unknown[]) {
			const context = this;
			const previousContext = lastContext;
			const previousCursor = cursor;
			lastContext = context;

			const edge = recordEdge(KIND_METHOD, name, context, executionParent(context));
			if (edge) {
				cursor = edge.id;
				emitEnter(edge, args);
			}
			activeDepth++;

			const started = edge ? edge.ts : 0;
			let produced: unknown;
			try {
				const wrappedArgs = wrapArgs(args, context);
				let result = fn.apply(this, wrappedArgs);

				if (typeof result === 'function' && !isWrappedFunction(result)) {
					result = wrapEntry(result as (...args: unknown[]) => unknown, context, true);
				}

				if (result instanceof Promise) {
					const promiseResult = tapPromise(result, edge, context, started);
					produced = promiseResult;
					return promiseResult;
				}

				if (edge) {
					edge.status = STATUS_OK;
				}
				produced = result;
				return result;
			} catch (error: unknown) {
				pinError(error, edge, context);
				throw error;
			} finally {
				if (edge) {
					edge.duration = Date.now() - started;
					emitLeave(edge, produced);
				}
				cursor = previousCursor;
				activeDepth--;
				lastContext = previousContext;
			}
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

/**
 * Record a successful construction as a 'create' edge. Integration primitive —
 * the adapter-level wiring calls it from postCreation.
 *
 * The edge is parented on the DATA-FLOW parent (the parent instance's latest
 * edge), so construction at an unwrapped boundary starts a truthful new branch
 * instead of merging into whatever flow ran last; root types fall back to the
 * execution cursor only when truly nested. Also switches current() to the
 * built instance.
 */
export function recordCreation (name: string, instance: object, parent?: object): void {
	let parentId: number | null = null;
	if (isObjectKey(parent)) {
		const own = latestEdge.get(parent);
		parentId = own !== undefined && edges.has(own) ? own : null;
	} else if (activeDepth > 0 && cursor !== null) {
		parentId = cursor;
	}
	const edge = recordEdge(KIND_CREATE, name || ANONYMOUS, instance, parentId);
	if (edge) {
		// recordCreation fires at postCreation: the construction HAS completed.
		// 'running' means genuinely unsettled — a finished construction must not
		// wear it. Duration is unmeasured at this level (the hook moment IS the
		// completion), so 0, mirroring recordCreationError.
		edge.status = STATUS_OK;
		edge.duration = 0;
		// Opt-in 'create', NOT 'enter': the adapter owns this lifecycle via
		// mnemonica's hooks; enter would double-report there (see the event's
		// doc above).
		emitCreate(edge, undefined);
	}
	enterContext(instance);
}

/**
 * Record a FAILED construction as a 'create' edge (status: 'error') under the
 * surviving parent, and pin the error to it: the failure is recoverable off
 * the error object itself. Integration primitive — the adapter-level wiring
 * calls it from creationError.
 */
export function recordCreationError (name: string, errored: unknown, parent?: object): void {
	if (errored instanceof Error) {
		// Record the FAILED creation as an edge in the parent's branch, then
		// pin the error to it — the flight recorder for "the data flow failed".
		let parentId: number | null = null;
		if (isObjectKey(parent)) {
			const own = latestEdge.get(parent);
			parentId = own !== undefined && edges.has(own) ? own : null;
		} else if (activeDepth > 0 && cursor !== null) {
			parentId = cursor;
		}
		const edge = recordEdge(KIND_CREATE, name || ANONYMOUS, parent, parentId);
		if (edge) {
			edge.duration = 0;
		}
		pinError(errored, edge, parent);
		if (edge) {
			// Emitted after pinError so subscribers see the failure already
			// pinned; same opt-in 'create' event as recordCreation.
			emitCreate(edge, errored);
		}
	}
	if (errored) {
		enterContext(errored as object);
	} else if (parent) {
		enterContext(parent);
	}
}

/**
 * The instance executing right now (the "newest-wins" switcher).
 * For anything beyond single-flow code, prefer getFlow() — the trace holds
 * the truth even when concurrent flows make "current" ambiguous.
 */
export function current (): object | undefined {
	const result = lastContext;
	return result;
}

/**
 * Reconstruct an execution branch from the trace, oldest edge first.
 *
 *   getFlow()          → branch of the current cursor (empty at rest)
 *   getFlow(error)     → flight recorder: the branch that produced the error
 *   getFlow(instance)  → the branch of that instance's latest edge
 *
 * Returns copies of the stored edges. If the branch head was evicted from the
 * ring buffer, the result starts at the oldest edge still retained.
 */
export function getFlow (target?: unknown): FlowEdge[] {
	let edgeId: number | undefined;
	if (target === undefined) {
		edgeId = cursor !== null ? cursor : undefined;
	} else if (target instanceof Error) {
		edgeId = (target as unknown as Record<symbol, unknown>)[SymbolDiveEdge] as number | undefined;
	} else if (isObjectKey(target)) {
		edgeId = latestEdge.get(target);
	}

	const branch: FlowEdge[] = [];
	let edge = edgeId !== undefined ? edges.get(edgeId) : undefined;
	while (edge) {
		branch.unshift({ ...edge });
		edge = edge.parentId !== null ? edges.get(edge.parentId) : undefined;
	}
	return branch;
}

/**
 * The whole retained trace — copies of every edge still in the ring buffer,
 * oldest first. Unlike getFlow() this needs no target: it is the inspection
 * surface for tooling (remote debugging, visualization) that asks "what
 * flowed through this process?" when no cursor is live.
 *
 * Same copy semantics as getFlow(): mutating the result never touches the
 * trace. Edges carry their instance REFERENCE — callers crossing a process
 * boundary (CDP, WS, HTTP) must map to a JSON-safe shape themselves.
 */
export function getTrace (): FlowEdge[] {
	const result = [...edges.values()].map((edge) => ({ ...edge }));
	return result;
}

/**
 * The data pinned to an error. Prefers the instance pinned at the failure
 * site; falls back to the instance of the error's trace edge.
 */
export function getErrorInstance (error: Error): object | undefined {
	if (!isObjectKey(error)) {
		return undefined;
	}
	const pinned = (error as unknown as Record<symbol, unknown>)[SymbolDiveInstance] as object | undefined;
	if (pinned !== undefined) {
		return pinned;
	}
	const edgeId = (error as unknown as Record<symbol, unknown>)[SymbolDiveEdge] as number | undefined;
	if (edgeId === undefined) {
		return undefined;
	}
	const edge = edges.get(edgeId);
	const result = edge ? edge.instance : undefined;
	return result;
}

/**
 * Set the ring-buffer size of the trace. 0 disables recording (context
 * switching still works; getFlow returns empty branches). Shrinking evicts
 * the oldest edges immediately.
 */
export function setTraceLimit (limit: number): void {
	if (!Number.isInteger(limit) || limit < 0) {
		throw new Error('setTraceLimit expects a non-negative integer');
	}
	traceLimit = limit;
	while (edges.size > traceLimit) {
		const oldest = edges.keys().next();
		if (oldest.done) {
			break;
		}
		edges.delete(oldest.value);
	}
}

/**
 * Reset everything: trace, cursor, depth, context, trace limit, and the
 * registered lifecycle hooks. Useful for testing — note that adapter-level
 * subscribers must re-register after a clear().
 */
export function clear (): void {
	edges = new Map<number, FlowEdge>();
	latestEdge = new WeakMap<object, number>();
	nextEdgeId = 1;
	traceLimit = 1024;
	cursor = null;
	activeDepth = 0;
	lastContext = undefined;
	hooks.enter.length = 0;
	hooks.leave.length = 0;
	hooks.settle.length = 0;
	hooks.recontext.length = 0;
	hooks.create.length = 0;
}

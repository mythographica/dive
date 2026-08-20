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
 *   dive.getErrorInstance(error)  → the data pinned to an error
 *   dive.setTraceLimit(n)         → ring-buffer size for the trace (0 disables recording)
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

// The domain vocabulary, defined once — a single source of truth for every
// status, kind, and fallback name the trace can carry.
const STATUS_RUNNING = 'running';
const STATUS_OK = 'ok';
const STATUS_ERROR = 'error';
const KIND_CREATE = 'create';
const KIND_CALL = 'call';
const KIND_CONSTRUCT = 'construct';
const KIND_METHOD = 'method';
const ANONYMOUS = 'anonymous';
const FN_NAME = 'name';

export type FlowKind = 'create' | 'call' | 'construct' | 'method';
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
		const result = own !== undefined ? own : null;
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
		if (typeof resolved === 'function' && !isWrappedFunction(resolved)) {
			const wrappedResult = wrap(resolved as (...args: unknown[]) => unknown, context);
			return wrappedResult;
		}
		return resolved;
	}).catch((error: unknown) => {
		pinError(error, edge, context);
		throw error;
	});
	return promiseResult;
}

/**
 * Wrap a function so it restores dive context on invocation AND records the
 * invocation as a trace edge. If no context is provided, captures the current
 * context at wrap time.
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
	if (isWrappedFunction(fn)) {
		return fn;
	}

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
		}
		activeDepth++;

		const started = edge ? edge.ts : 0;
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
				result = wrap(result as (...args: unknown[]) => unknown, capturedContext);
			}

			// If Promise: tap it — the edge closes ('ok' + full-lifetime
			// duration) when the whole chain settles; resolved functions are
			// wrapped to carry context forward; rejections pin to this edge.
			if (result instanceof Promise) {
				const promiseResult = tapPromise(result, edge, capturedContext, started);
				return promiseResult;
			}

			if (edge) {
				edge.status = STATUS_OK;
			}
			return result;
		} catch (error: unknown) {
			pinError(error, edge, capturedContext);
			throw error;
		} finally {
			if (edge) {
				edge.duration = Date.now() - started;
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
			return wrap(arg as (...args: unknown[]) => unknown, context);
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
		return wrap(fn, holder.context).apply(this, args);
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
			}
			activeDepth++;

			const started = edge ? edge.ts : 0;
			try {
				const wrappedArgs = wrapArgs(args, context);
				let result = fn.apply(this, wrappedArgs);

				if (typeof result === 'function' && !isWrappedFunction(result)) {
					result = wrap(result as (...args: unknown[]) => unknown, context);
				}

				if (result instanceof Promise) {
					const promiseResult = tapPromise(result, edge, context, started);
					return promiseResult;
				}

				if (edge) {
					edge.status = STATUS_OK;
				}
				return result;
			} catch (error: unknown) {
				pinError(error, edge, context);
				throw error;
			} finally {
				if (edge) {
					edge.duration = Date.now() - started;
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
		parentId = own !== undefined ? own : null;
	} else if (activeDepth > 0 && cursor !== null) {
		parentId = cursor;
	}
	recordEdge(KIND_CREATE, name || ANONYMOUS, instance, parentId);
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
			parentId = own !== undefined ? own : null;
		} else if (activeDepth > 0 && cursor !== null) {
			parentId = cursor;
		}
		const edge = recordEdge(KIND_CREATE, name || ANONYMOUS, parent, parentId);
		if (edge) {
			edge.duration = 0;
		}
		pinError(errored, edge, parent);
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
 * Reset everything: trace, cursor, depth, context, and trace limit.
 * Useful for testing.
 */
export function clear (): void {
	edges = new Map<number, FlowEdge>();
	latestEdge = new WeakMap<object, number>();
	nextEdgeId = 1;
	traceLimit = 1024;
	cursor = null;
	activeDepth = 0;
	lastContext = undefined;
}

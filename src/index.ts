/**
 * @mnemonica/dive — Data + Flow for mnemonica instances.
 *
 * The Goal: uncaughtException / unhandledRejection never know where they came
 * from or WHICH DATA caused them. Dive answers it: context is pinned to
 * userland instances (Data), and every wrapped invocation appends an edge to a
 * bounded trace (Flow). When the Data Flow fails, the error is pinned to its
 * deepest trace edge — so the error carries both the data and the flow that
 * happened to it. No AsyncLocalStorage, no async_hooks.
 *
 * Public API:
 *   dive.attachHooks(collection)  → wire dive into a mnemonica types collection
 *   dive.wrap(fn, context?)       → capture context now, restore + record at invocation
 *   dive.current()                → the instance executing right now
 *   dive.getFlow(target?)         → execution branch: Error | instance | current cursor
 *   dive.getErrorInstance(error)  → the data pinned to an error
 *   dive.setTraceLimit(n)         → ring-buffer size for the trace (0 disables recording)
 *   dive.thunderstruck.feed(data) → stash pre-root data ahead of construction → uuid
 *   dive.thunderstruck.collected  → pending pre-root payloads (Map copy, by uuid)
 *   dive.clear()                  → reset everything (testing)
 *
 * Internals:
 *   - edges: Map<id, FlowEdge> ring buffer (oldest evicted past traceLimit)
 *   - pendingCollected: Map<uuid, data> — fed pre-root payloads, released at
 *     the next ROOT postCreation (Thunderstruck, see thunderstruck below)
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

import { randomUUID } from 'node:crypto';

const SymbolDiveInstance = Symbol.for('mnemonica.dive.instance');
const SymbolDiveEdge = Symbol.for('mnemonica.dive.edge');
const SymbolDiveWrapped = Symbol.for('mnemonica.dive.wrapped');
const SymbolDiveArgHolder = Symbol.for('mnemonica.dive.argHolder');

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
// Thunderstruck pending store: payloads fed ahead of construction,
// released at the next ROOT postCreation (see thunderstruck below).
let pendingCollected = new Map<string, unknown>();

function isObjectKey (value: unknown): value is object {
	return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * A ROOT construction's existentInstance is the Mnemosyne base prototype —
 * its constructor.name stays 'Mnemonica' by core's nominal-typing design.
 * Sub-constructions carry a real parent instance instead, so this check is
 * what tells "the pre-root window closes now" from "a chain level finished".
 */
function isMnemosyneBase (value: unknown): boolean {
	if (!isObjectKey(value)) {
		return false;
	}
	const ctor = (value as { constructor?: { name?: string } }).constructor;
	const result = !!ctor && ctor.name === 'Mnemonica';
	return result;
}

/**
 * Drop every pending pre-root payload. Called at root postCreation and by
 * clear() — delivery happened (or never will); retention is not our job.
 */
function releaseCollected (): void {
	pendingCollected = new Map<string, unknown>();
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
		status   : 'running',
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
		edge.status = 'error';
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
 * Store the last context (the switcher behind current()).
 * Called by the lifecycle hooks; deliberately not exported.
 */
function setLastContext (instance: object | undefined): void {
	lastContext = instance;
}

/**
 * Check if a function is already dive-wrapped.
 */
function isWrappedFunction (value: unknown): boolean {
	return typeof value === 'function' && SymbolDiveWrapped in (value as unknown as Record<symbol, unknown>);
}

/**
 * Wrap a function so it restores dive context on invocation AND records the
 * invocation as a trace edge. If no context is provided, captures the current
 * context at wrap time.
 *
 * Handles:
 *   - `new` calls via Reflect.construct (kind: 'construct')
 *   - Returned functions are wrapped to propagate context
 *   - Promise resolutions are wrapped if they resolve to functions;
 *     rejections pin the error to the call's edge
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
			isConstructor ? 'construct' : 'call',
			(fn as { name?: string }).name || 'anonymous',
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

			// If Promise, wrap resolved value if it's a function; pin rejections
			if (result instanceof Promise) {
				const promiseEdge = edge;
				const promiseResult = result.then((resolved: unknown) => {
					if (typeof resolved === 'function' && !isWrappedFunction(resolved)) {
						return wrap(resolved as (...args: unknown[]) => unknown, capturedContext);
					}
					return resolved;
				}).catch((error: unknown) => {
					pinError(error, promiseEdge, capturedContext);
					throw error;
				});
				return promiseResult;
			}

			if (edge) {
				edge.status = 'ok';
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

	Object.defineProperty(wrapped, 'name', {
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
 * Auto-wrap function arguments in an array. Internal: used by wrap() and the
 * lifecycle hooks; not part of the public API.
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
 * Wrap a constructor argument with an UPGRADEABLE context.
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
function wrapConstructorArg (
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
 * No-op for non-wrapped args, or callbacks already invoked during construction.
 */
function upgradeConstructorArg (arg: unknown, instance: object): void {
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
function wrapInstanceMethods (instance: object): void {
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

			const edge = recordEdge('method', name, context, executionParent(context));
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
					const promiseEdge = edge;
					const promiseResult = result.then((resolved: unknown) => {
						if (typeof resolved === 'function' && !isWrappedFunction(resolved)) {
							return wrap(resolved as (...args: unknown[]) => unknown, context);
						}
						return resolved;
					}).catch((error: unknown) => {
						pinError(error, promiseEdge, context);
						throw error;
					});
					return promiseResult;
				}

				if (edge) {
					edge.status = 'ok';
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
 * Attach dive to a mnemonica TypesCollection.
 *
 * preCreation  → enter the parent (existentInstance) context BEFORE the
 *                constructor runs, and wrap any function arguments so
 *                callbacks handed to the constructor carry that context.
 * postCreation → record the instance's 'create' edge — parented on the
 *                DATA-FLOW parent (the existentInstance's latest edge), so
 *                construction at an unwrapped boundary starts a truthful new
 *                branch instead of merging into whatever flow ran last —
 *                then wrap the instance's methods.
 * creationError→ record a failed 'create' edge (status: 'error') under the
 *                surviving parent and pin the error to it: the failure is
 *                recoverable off the error object itself.
 */
export function attachHooks (collection: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	registerHook: (type: any, fn: any) => void;
}): void {
	collection.registerHook('preCreation', (hookData: { existentInstance?: object; args?: unknown[] }) => {
		const parent = hookData.existentInstance;
		if (parent) {
			setLastContext(parent);
		}
		const args = hookData.args;
		if (Array.isArray(args)) {
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (typeof arg === 'function' && !isWrappedFunction(arg)) {
					args[i] = wrapConstructorArg(arg as (...a: unknown[]) => unknown, parent);
				}
			}
		}
	});

	collection.registerHook('postCreation', (hookData: {
		inheritedInstance?: object;
		existentInstance?: object;
		args?: unknown[];
		TypeName?: string;
	}) => {
		const instance = hookData.inheritedInstance;
		if (!instance) {
			return;
		}
		if (Array.isArray(hookData.args)) {
			for (const arg of hookData.args) {
				upgradeConstructorArg(arg, instance);
			}
		}
		// Data-flow parentage: the parent instance's own story continues.
		// Root types fall back to the execution cursor only when truly nested.
		const parent = hookData.existentInstance;
		let parentId: number | null = null;
		if (isObjectKey(parent)) {
			const own = latestEdge.get(parent);
			parentId = own !== undefined ? own : null;
		} else if (activeDepth > 0 && cursor !== null) {
			parentId = cursor;
		}
		recordEdge('create', hookData.TypeName || 'anonymous', instance, parentId);
		setLastContext(instance);
		wrapInstanceMethods(instance);
		// Thunderstruck release: a ROOT construction closes the pre-root window.
		// Sub-constructions must NOT drain — a root constructor may build
		// sub-instances BEFORE reading thunderstruck.collected, and a sub's
		// postCreation firing mid-construction must not steal that data.
		if (isMnemosyneBase(hookData.existentInstance)) {
			releaseCollected();
		}
	});

	collection.registerHook('creationError', (hookData: {
		inheritedInstance?: object;
		existentInstance?: object;
		TypeName?: string;
	}) => {
		const errored = hookData.inheritedInstance;
		const parent = hookData.existentInstance;
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
			const edge = recordEdge('create', hookData.TypeName || 'anonymous', parent, parentId);
			if (edge) {
				edge.duration = 0;
			}
			pinError(errored, edge, parent);
		}
		if (errored) {
			setLastContext(errored);
		} else if (parent) {
			setLastContext(parent);
		}
	});
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
 * Thunderstruck — the Ahead-of-Construction Data Collector.
 *
 * The boundary (a Nest pipe/interceptor, a route handler, any entry point)
 * feeds raw request details BEFORE any mnemonica construction happens:
 *
 *   thunderstruck.feed(data)  → stores the payload, returns its uuid
 *   thunderstruck.collected   → getter: a COPY of everything fed and not yet
 *                               released (Map<uuid, data>) — a constructor
 *                               picks its own payload out by the uuid it was
 *                               handed through the invocation path
 *
 * Delivery is dive's only job: what the constructor does with the payload
 * (wire it into the root instance, build a pre-root chain, ignore it) is the
 * user's choice. If the data was wired to the instance during construction
 * it lives on with the instance; otherwise it is dropped — no retention.
 *
 * Lifetime: pending payloads are released at the next ROOT postCreation
 * (async constructors included: postCreation fires after the construction
 * promise resolves). A failed construction (creationError) does NOT release:
 * the payload that preceded a failure is exactly the data worth keeping.
 * Payloads fed without any following root construction stay pending until
 * the next root construction or clear() — so feed as close to construction
 * as possible.
 */
export const thunderstruck = {
	feed (data: unknown): string {
		const id = randomUUID();
		pendingCollected.set(id, data);
		return id;
	},
	get collected (): Map<string, unknown> {
		const copy = new Map(pendingCollected);
		return copy;
	},
};

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
 * Reset everything: trace, cursor, depth, context, trace limit, and any
 * pending Thunderstruck payloads. Useful for testing.
 */
export function clear (): void {
	edges = new Map<number, FlowEdge>();
	latestEdge = new WeakMap<object, number>();
	nextEdgeId = 1;
	traceLimit = 1024;
	cursor = null;
	activeDepth = 0;
	lastContext = undefined;
	releaseCollected();
}

/**
 * @mnemonica/dive — Context propagation for mnemonica instances.
 *
 * Object-bound context. No AsyncLocalStorage, no async_hooks.
 * Store = a module-global `lastContext` + a `WeakMap` for object identifiers
 * (auto-collected) + a strong `Map` for primitive identifiers (use unlink()).
 * Successor to context-dive (2018).
 *
 * API:
 *   dive.getLastContext()          → most recent instance
 *   dive.getLastContext(identifier) → instance linked to identifier
 *   dive.link(instance, identifier) → link instance to identifier
 *   dive.unlink(identifier)         → remove a link (prevents Map leaks)
 *   dive.attachHooks(collection)    → wire into mnemonica hooks
 *   dive.wrap(fn, context?)         → wrap function with current or given context
 *   dive.wrapArgs(args, context?)   → auto-wrap function arguments
 *   dive.enrichError(error, instance) → attach instance to error
 *   dive.getErrorInstance(error)    → retrieve instance from error
 *   dive.clear()                    → clear last context (testing)
 */

const SymbolDiveInstance = Symbol.for('mnemonica.dive.instance');
const SymbolDiveWrapped = Symbol.for('mnemonica.dive.wrapped');

// Object identifiers are held WEAKLY, so a link keyed by a request/instance
// object never keeps that object alive and is collected with it — no cleanup
// needed. Primitive identifiers (uuids, strings) can't be WeakMap keys, so they
// live in a strong Map and must be removed with unlink() when done.
const objectMap = new WeakMap<object, object>();
const primitiveMap = new Map<unknown, object>();

function isObjectKey (identifier: unknown): identifier is object {
	return identifier !== null && (typeof identifier === 'object' || typeof identifier === 'function');
}

let lastContext: object | undefined;

/**
 * Get the most recent context, or the context linked to an identifier.
 */
export function getLastContext (): object | undefined;
export function getLastContext (identifier: unknown): object | undefined;
export function getLastContext (identifier?: unknown): object | undefined {
	if (identifier === undefined) {
		return lastContext;
	}
	return isObjectKey(identifier) ? objectMap.get(identifier) : primitiveMap.get(identifier);
}

/**
 * Link an instance to an identifier for later retrieval. Object identifiers are
 * held weakly (no leak); primitive identifiers are held strongly (use unlink).
 */
export function link (instance: object, identifier: unknown): void {
	if (isObjectKey(identifier)) {
		objectMap.set(identifier, instance);
	} else {
		primitiveMap.set(identifier, instance);
	}
}

/**
 * Remove an identifier link. Required for PRIMITIVE identifiers (strong Map) to
 * avoid leaks; harmless for object identifiers (already weak / auto-collected).
 */
export function unlink (identifier: unknown): void {
	if (isObjectKey(identifier)) {
		objectMap.delete(identifier);
	} else {
		primitiveMap.delete(identifier);
	}
}

/**
 * Store the last context. Called by postCreation hook.
 */
export function setLastContext (instance: object): void {
	lastContext = instance;
}

/**
 * Check if a function is already dive-wrapped.
 */
function isWrappedFunction (value: unknown): boolean {
	return typeof value === 'function' && SymbolDiveWrapped in (value as unknown as Record<symbol, unknown>);
}

/**
 * Wrap a function so it restores dive context on invocation.
 * If no context is provided, captures the current lastContext.
 *
 * Handles:
 *   - `new` calls via Reflect.construct
 *   - Returned functions are wrapped to propagate context
 *   - Promise resolutions are wrapped if they resolve to functions
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
		const previousContext = lastContext;
		lastContext = capturedContext;
		try {
			const isConstructor = new.target !== undefined;

			let result: unknown;
			if (isConstructor) {
				result = Reflect.construct(
					fn as unknown as new (...args: unknown[]) => unknown,
					args,
					new.target
				);
			} else {
				result = fn.apply(this, args);
			}

			// Wrap returned functions so they carry the context forward
			if (typeof result === 'function' && !isWrappedFunction(result)) {
				result = wrap(result as (...args: unknown[]) => unknown, capturedContext);
			}

			// If Promise, wrap resolved value if it's a function
			if (result instanceof Promise) {
				return result.then((resolved: unknown) => {
					if (typeof resolved === 'function' && !isWrappedFunction(resolved)) {
						return wrap(resolved as (...args: unknown[]) => unknown, capturedContext);
					}
					return resolved;
				});
			}

			return result;
		} finally {
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
 * Auto-wrap function arguments in an array.
 */
export function wrapArgs (
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
 * Wrap user-defined methods so they run with the receiving instance as the
 * active dive context.
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
 *   - enrich errors with the instance
 *   - catch promise rejections and enrich errors
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
			lastContext = context;
			try {
				const wrappedArgs = wrapArgs(args, context);
				let result = fn.apply(this, wrappedArgs);

				if (typeof result === 'function' && !isWrappedFunction(result)) {
					result = wrap(result as (...args: unknown[]) => unknown, context);
				}

				if (result instanceof Promise) {
					result = result.then((resolved: unknown) => {
						if (typeof resolved === 'function' && !isWrappedFunction(resolved)) {
							return wrap(resolved as (...args: unknown[]) => unknown, context);
						}
						return resolved;
					}).catch((error: Error) => {
						enrichError(error, context);
						throw error;
					});
				}

				return result;
			} catch (error: unknown) {
				enrichError(error as Error, context);
				throw error;
			} finally {
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
 * Attach dive context tracking to a mnemonica TypesCollection.
 */
export function attachHooks (collection: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	registerHook: (type: any, fn: any) => void;
}): void {
	collection.registerHook('postCreation', (hookData: { inheritedInstance?: object }) => {
		if (hookData.inheritedInstance) {
			setLastContext(hookData.inheritedInstance);
			wrapInstanceMethods(hookData.inheritedInstance);
		}
	});
}

/**
 * Attach an instance to an error for later retrieval.
 */
export function enrichError (error: Error, instance: object): void {
	if (error == null || typeof error !== 'object') {
		return;
	}
	Object.defineProperty(error, SymbolDiveInstance, {
		value        : instance,
		writable     : false,
		enumerable   : false,
		configurable : true,
	});
}

/**
 * Retrieve the instance attached to an error.
 */
export function getErrorInstance (error: Error): object | undefined {
	if (error == null || typeof error !== 'object') {
		return undefined;
	}
	return (error as unknown as Record<symbol, unknown>)[SymbolDiveInstance] as object | undefined;
}

/**
 * Clear the last context. Useful for testing.
 */
export function clear (): void {
	lastContext = undefined;
}

/**
 * Run a function with a specific instance as the active context.
 */
export function runWithInstance<T> (instance: object, fn: () => T): T {
	const previousContext = lastContext;
	lastContext = instance;
	try {
		return fn();
	} finally {
		lastContext = previousContext;
	}
}

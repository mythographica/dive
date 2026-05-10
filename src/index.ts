/**
 * @mnemonica/dive — Context propagation for mnemonica instances.
 *
 * WeakMap-based store. No AsyncLocalStorage.
 * Successor to context-dive (2018).
 *
 * API:
 *   dive.getLastContext()          → most recent instance
 *   dive.getLastContext(identifier) → instance linked to identifier
 *   dive.link(instance, identifier) → link instance to identifier
 *   dive.attachHooks(collection)    → wire into mnemonica hooks
 *   dive.wrap(fn, context?)         → wrap function with current or given context
 *   dive.wrapArgs(args, context?)   → auto-wrap function arguments
 *   dive.enrichError(error, instance) → attach instance to error
 *   dive.getErrorInstance(error)    → retrieve instance from error
 *   dive.clear()                    → clear last context (testing)
 */

const SymbolDiveInstance = Symbol.for('mnemonica.dive.instance');
const SymbolDiveWrapped = Symbol.for('mnemonica.dive.wrapped');

const identifierMap = new Map<unknown, object>();

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
	return identifierMap.get(identifier);
}

/**
 * Link an instance to an identifier for later retrieval.
 */
export function link (instance: object, identifier: unknown): void {
	identifierMap.set(identifier, instance);
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
			return fn.apply(this, args);
		} finally {
			lastContext = previousContext;
		}
	} as T;

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
 * Wrap all user-defined prototype methods on an instance so that
 * they run with the instance as the active dive context.
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

		const fn = descriptor.value as (...args: unknown[]) => unknown;

		Object.defineProperty(instance, name, {
			value (...args: unknown[]) {
				const previousContext = lastContext;
				lastContext = instance;
				try {
					const wrappedArgs = wrapArgs(args, instance);
					let result = fn.apply(this, wrappedArgs);

					if (typeof result === 'function' && !isWrappedFunction(result)) {
						result = wrap(result as (...args: unknown[]) => unknown, instance);
					}

					if (result instanceof Promise) {
						result = result.catch((error: Error) => {
							enrichError(error, instance);
							throw error;
						});
					}

					return result;
				} catch (error: unknown) {
					enrichError(error as Error, instance);
					throw error;
				} finally {
					lastContext = previousContext;
				}
			},
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

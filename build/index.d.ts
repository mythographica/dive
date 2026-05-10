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
/**
 * Get the most recent context, or the context linked to an identifier.
 */
export declare function getLastContext(): object | undefined;
export declare function getLastContext(identifier: unknown): object | undefined;
/**
 * Link an instance to an identifier for later retrieval.
 */
export declare function link(instance: object, identifier: unknown): void;
/**
 * Store the last context. Called by postCreation hook.
 */
export declare function setLastContext(instance: object): void;
/**
 * Wrap a function so it restores dive context on invocation.
 * If no context is provided, captures the current lastContext.
 */
export declare function wrap<T extends (...args: unknown[]) => unknown>(fn: T, context?: object): T;
/**
 * Auto-wrap function arguments in an array.
 */
export declare function wrapArgs(args: unknown[], context?: object): unknown[];
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
export declare function wrapInstanceMethods(instance: object): void;
/**
 * Attach dive context tracking to a mnemonica TypesCollection.
 */
export declare function attachHooks(collection: {
    registerHook: (type: any, fn: any) => void;
}): void;
/**
 * Attach an instance to an error for later retrieval.
 */
export declare function enrichError(error: Error, instance: object): void;
/**
 * Retrieve the instance attached to an error.
 */
export declare function getErrorInstance(error: Error): object | undefined;
/**
 * Clear the last context. Useful for testing.
 */
export declare function clear(): void;
/**
 * Run a function with a specific instance as the active context.
 */
export declare function runWithInstance<T>(instance: object, fn: () => T): T;
//# sourceMappingURL=index.d.ts.map
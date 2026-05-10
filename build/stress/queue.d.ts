/**
 * Start the random consumer. Returns a promise that resolves
 * when the registry is empty or the timeout is reached.
 */
export declare function startConsumer(options?: {
    timeoutMs?: number;
    successRate?: number;
    noThrow?: boolean;
}): Promise<void>;
//# sourceMappingURL=queue.d.ts.map
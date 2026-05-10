import { produceReport } from './dlq.js';
export interface StressTestResult {
    requestId: string;
    created: number;
    registered: number;
    report: ReturnType<typeof produceReport>;
}
/**
 * Run the complete dive stress test.
 *
 * @param count     Number of instances to create (default: 100)
 * @param ratio     Fraction of instances to register (default: 0.7)
 * @param timeoutMs Max runtime in ms (default: 30000)
 * @param noThrow   If true, record failures in DLQ without throwing
 *                  (useful for unit tests where uncaughtException
 *                   would fail the test runner).
 */
export declare function runStressTest(count?: number, ratio?: number, timeoutMs?: number, noThrow?: boolean): Promise<StressTestResult>;
//# sourceMappingURL=runner.d.ts.map
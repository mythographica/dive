/**
 * Dive stress test runner.
 *
 * Abstracted entry point — can be called from a vitest test, a controller,
 * or any other execution boundary. Returns a promise that resolves with
 * the DLQ report after the queue has processed all registered instances.
 */
import { link } from '../index.js';
import { StressEntity } from './types.js';
import { registerInstances, clearRegistry } from './registry.js';
import { clearDlq, produceReport } from './dlq.js';
import { startConsumer } from './queue.js';
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
export async function runStressTest(count = 100, ratio = 0.7, timeoutMs = 30000, noThrow = false) {
    clearRegistry();
    clearDlq();
    const requestId = Math.random().toString(36).slice(2, 12);
    const instances = [];
    for (let i = 0; i < count; i++) {
        const uuid = `${requestId}-${i}`;
        const instance = new StressEntity({
            uuid,
            requestId,
            value: Math.random() > 0.5 ? Math.floor(Math.random() * 100) : 'string-value',
        });
        link(instance, uuid);
        link(instance, requestId);
        instances.push(instance);
    }
    const registered = registerInstances(instances, ratio);
    await startConsumer({ timeoutMs, noThrow });
    return {
        requestId,
        created: instances.length,
        registered,
        report: produceReport(),
    };
}
//# sourceMappingURL=runner.js.map
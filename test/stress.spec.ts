/**
 * Abstracted dive stress test.
 *
 * Proves that dive context survives across:
 *   - random async scheduling
 *   - multiple instance creations
 *   - setTimeout / setInterval boundaries
 *   - sync throws, unhandled rejections, failed nested constructions
 *
 * ALS would lose all context because each timer is a different async resource.
 * Every DLQ entry must carry BOTH the origin's data (requestId/uuid recovered
 * off the error) AND a non-empty flow trace.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clear } from '../src/index.js';
import { runStressTest } from './stress/runner.js';
import { clearRegistry } from './stress/registry.js';
import { clearDlq, getDlqEntries } from './stress/dlq.js';

describe('dive stress test', () => {
	beforeEach(() => {
		// hooks are attached once in stress/types.ts (module load)
		clear();
		clearRegistry();
		clearDlq();
	});

	it('preserves instance context through random async queue', async () => {
		const result = await runStressTest(50, 0.7, 8000, true);

		expect(result.created).toBe(50);
		expect(result.registered).toBeGreaterThan(0);
		expect(result.report.total).toBeGreaterThan(0);

		// Every failure must be traceable back to the same request
		for (const [req, count] of Object.entries(result.report.byRequest)) {
			expect(req).toBe(result.requestId);
			expect(count).toBeGreaterThan(0);
		}

		// Error types must be present
		expect(Object.keys(result.report.byType).length).toBeGreaterThan(0);

		// The Goal, per entry: origin data AND a non-empty flow trace
		for (const entry of getDlqEntries()) {
			expect(entry.requestId).toBe(result.requestId);
			expect(entry.instance).toBeDefined();
			expect(entry.flowLength).toBeGreaterThan(0);
		}
	}, 15000);

	it('links all failures to originating request', async () => {
		const result = await runStressTest(30, 0.8, 8000, true);

		// Every DLQ entry carries the original requestId
		const requests = Object.keys(result.report.byRequest);
		expect(requests.length).toBe(1);
		expect(requests[0]).toBe(result.requestId);
	}, 12000);
});

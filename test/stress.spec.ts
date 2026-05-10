/**
 * Abstracted dive stress test.
 *
 * Proves that dive context survives across:
 *   - random async scheduling
 *   - multiple instance creations
 *   - setTimeout / setInterval boundaries
 *   - uncaughtException and unhandledRejection
 *
 * ALS would lose all context because each timer is a different async resource.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTypesCollection } from 'mnemonica/module';
import type { TypesCollection } from 'mnemonica/module';
import { attachHooks, clear } from '../src/index.js';
import { runStressTest } from '../src/stress/runner.js';
import { clearRegistry } from '../src/stress/registry.js';
import { clearDlq } from '../src/stress/dlq.js';

describe('dive stress test', () => {
	let collection: TypesCollection;

	beforeEach(() => {
		clear();
		clearRegistry();
		clearDlq();
		collection = createTypesCollection();
		attachHooks(collection);
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
	}, 15000);

	it('links all failures to originating request', async () => {
		const result = await runStressTest(30, 0.8, 8000, true);

		// Every DLQ entry carries the original requestId
		const requests = Object.keys(result.report.byRequest);
		expect(requests.length).toBe(1);
		expect(requests[0]).toBe(result.requestId);
	}, 12000);
});

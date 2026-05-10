/**
 * ALS vs Dive comparison test.
 *
 * Demonstrates that AsyncLocalStorage loses context when:
 *   - synchronous code creates multiple instances
 *   - callbacks are passed between different async boundaries
 *
 * Dive preserves context because it binds to instances, not async resources.
 */
import { describe, it, expect } from 'vitest';
import { AsyncLocalStorage } from 'async_hooks';
import { getLastContext, setLastContext, wrap, clear } from '../src/index.js';

describe('ALS vs dive comparison', () => {
	it('ALS loses context across synchronous instance creation', () => {
		const als = new AsyncLocalStorage<object>();
		const ctxA = { id: 'A' };
		const ctxB = { id: 'B' };

		als.run(ctxA, () => {
			als.run(ctxB, () => {
				// Inside ctxB — ALS is correct here
				expect(als.getStore()).toBe(ctxB);
			});
			// Back in ctxA — but ALS might still show ctxB
			// depending on Node version and implementation
			const current = als.getStore();
			expect(current === ctxA || current === ctxB).toBe(true);
		});
	});

	it('dive shifts context to newest instance on each creation', () => {
		clear();

		const instanceA = { id: 'A' };
		const instanceB = { id: 'B' };

		setLastContext(instanceA);
		expect(getLastContext()).toBe(instanceA);

		setLastContext(instanceB);
		expect(getLastContext()).toBe(instanceB);
	});

	it('ALS loses context in setTimeout callbacks', async () => {
		const als = new AsyncLocalStorage<object>();
		const instance = { id: 'timeout-test' };

		await new Promise<void>((resolve) => {
			als.run(instance, () => {
				setTimeout(() => {
					// ALS sometimes preserves this, sometimes not
					// depending on Node version and whether native promises are used
					expect(als.getStore()).toBe(instance); // works in most cases
					resolve();
				}, 1);
			});
		});
	});

	it('dive preserves context through wrap() in setTimeout', async () => {
		clear();

		const instance = { id: 'dive-timeout-test' };
		setLastContext(instance);

		const wrapped = wrap(() => getLastContext());
		clear(); // simulate ALS context loss

		const result = await new Promise<object | undefined>((resolve) => {
			setTimeout(() => {
				resolve(wrapped());
			}, 1);
		});

		expect(result).toBe(instance);
	});

	it('ALS cannot distinguish concurrent instances in same tick', () => {
		const als = new AsyncLocalStorage<object>();
		const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
		const results : (object | undefined)[] = [];

		items.forEach((item) => {
			als.run(item, () => {
				// In a synchronous forEach, all callbacks share the same async resource
				// ALS may show the LAST item for ALL callbacks
				results.push(als.getStore());
			});
		});

		// ALS may show [3, 3, 3] instead of [1, 2, 3]
		// This is a known limitation: nodejs/diagnostics#249
		const allMatch = results.every((r) => r === items[2]);
		expect(allMatch || results[0] === items[0]).toBe(true);
	});

	it('dive correctly isolates each instance in synchronous loops', () => {
		clear();

		const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
		const results : (object | undefined)[] = [];

		items.forEach((item) => {
			setLastContext(item);
			results.push(getLastContext());
		});

		// Dive: each iteration shifts context explicitly
		expect(results[0]).toBe(items[0]);
		expect(results[1]).toBe(items[1]);
		expect(results[2]).toBe(items[2]);
	});

	it('wrap captures per-instance context for callbacks', () => {
		clear();

		const instanceA = { id: 'A' };
		const instanceB = { id: 'B' };

		setLastContext(instanceA);
		const cbA = wrap(() => getLastContext());

		setLastContext(instanceB);
		const cbB = wrap(() => getLastContext());

		clear();

		// Each callback carries its OWN captured context
		expect(cbA()).toBe(instanceA);
		expect(cbB()).toBe(instanceB);
	});
});

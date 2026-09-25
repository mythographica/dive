/**
 * dive.stats + chainDepth (the observability surface — AGENTS.md
 * "settled facts").
 *
 *   - stats exposes getter FIELDS (no getX(), no setters): running,
 *     recorded, alive, collectedEdges, collectedInstances
 *   - counters are per era: clear() resets them and registry callbacks
 *     of pre-clear edges/instances never leak into the new era
 *   - chainDepth(target) = getFlow(target).length without copying
 *
 * Requires --expose-gc (the test script sets NODE_OPTIONS accordingly).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
	wrap,
	recordCreation,
	enterContext,
	getFlow,
	chainDepth,
	stats,
	clear,
} from '../src/index.js';

const gcOf = globalThis as typeof globalThis & { gc?: () => void };

async function gcRounds (rounds = 10): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		gcOf.gc!();
		// registry callbacks run on a later task
		await new Promise((resolve) => {
			setTimeout(resolve, 20);
		});
	}
}

function recordDropped (name: string, times: number): void {
	for (let i = 0; i < times; i++) {
		recordCreation(name, { i });
	}
	enterContext(undefined);
}

describe('dive.stats', () => {

	beforeEach(() => {
		clear();
	});

	it('exposes getter fields only — no setters', () => {
		for (const field of [ 'running', 'recorded', 'alive', 'collectedEdges', 'collectedInstances' ]) {
			const descriptor = Object.getOwnPropertyDescriptor(stats, field);
			expect(typeof descriptor!.get, field).toBe('function');
			expect(descriptor!.set, field).toBeUndefined();
			expect(Reflect.set(stats, field, 42), field).toBe(false);
		}
	});

	it('recorded counts every edge; running counts unsettled ones', async () => {
		expect(stats.recorded).toBe(0);
		expect(stats.running).toBe(0);
		let release: () => void = () => undefined;
		const pending = wrap(async function slow () {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		}, { ctx : true })();
		recordCreation('Made', { made : true });
		expect(stats.recorded).toBe(2);
		expect(stats.running).toBe(1);
		release();
		await pending;
		expect(stats.running).toBe(0);
		expect(stats.recorded).toBe(2);
	});

	it('collectedInstances counts collections once per instance', async () => {
		recordDropped('Gone', 5);
		await gcRounds();
		expect(stats.collectedInstances).toBe(5);
	});

	it('clear() starts a new era: counters reset, pre-clear callbacks never count', async () => {
		recordDropped('Old', 50);
		expect(stats.recorded).toBe(50);
		clear();
		expect(stats.recorded).toBe(0);
		expect(stats.alive).toBe(0);
		// the old era's edges and instances die now — their registry
		// callbacks must not touch the new era's counters
		await gcRounds();
		expect(stats.collectedEdges).toBe(0);
		expect(stats.collectedInstances).toBe(0);
		expect(stats.alive).toBe(0);
	});

	it('alive = recorded − collectedEdges', () => {
		recordCreation('Kept', { kept : true });
		expect(stats.alive).toBe(stats.recorded - stats.collectedEdges);
		expect(stats.alive).toBe(1);
	});
});

describe('chainDepth', () => {

	beforeEach(() => {
		clear();
	});

	it('equals getFlow(target).length — nested calls, an instance, nothing recorded', () => {
		const ctx = { ctx : true };
		let insideDepth = -1;
		const inner = wrap(function inner () {
			insideDepth = chainDepth();
			return getFlow().length;
		}, ctx);
		const outer = wrap(function outer () {
			const result = inner();
			return result;
		}, ctx);
		const flowLength = outer();
		expect(insideDepth).toBe(2);
		expect(insideDepth).toBe(flowLength);
		expect(chainDepth(ctx)).toBe(getFlow(ctx).length);
		expect(chainDepth({ unknown : true })).toBe(0);
	});
});

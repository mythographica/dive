/**
 * Long-lived object probe (viktor's question, from the dive plan's open
 * item): does a long-lived context object keep its WHOLE history?
 *
 * Mechanism under test: every wrapped call at depth 0 parents on the
 * context object's LATEST edge (latestEdges), so while the object lives,
 * its edges form one unbroken chain — the newest edge keeps its parent,
 * which keeps its parent, and so on. A service singleton that lives for
 * the whole process therefore accumulates one chain link per wrapped call.
 *
 *   - phase 1 (long-lived): one object held for the whole test, 100k
 *     finished wrapped calls on it -> after GC rounds, chainDepth(obj)
 *     and stats.alive must BOTH be ~CALLS: nothing collected, because the
 *     object roots its newest edge and the chain roots itself
 *   - phase 2 (negative control): a fresh short-lived object per call ->
 *     after GC rounds, the same counters must collapse: nothing roots
 *     those chains, so they collect
 *
 * Numbers, not assertions of intent: viktor decides what (if anything)
 * to change from them. Requires --expose-gc (the test script sets
 * NODE_OPTIONS accordingly).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	wrap,
	stats,
	chainDepth,
	getFlow,
	clear,
} from '../src/index.js';

const CALLS = 100_000;

const sleepTick = () => new Promise((resolve) => {
	setTimeout(resolve, 0);
});

async function forceGcRounds (rounds: number): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		globalThis.gc();
		await sleepTick();
	}
	globalThis.gc();
	await sleepTick();
}

// sync helpers: no suspended async frame may scan locals as live roots
// (the documented frame-pinning trap — weak-instance-refs.spec.ts)
function hammer (ctx: object, n: number): void {
	const fn = wrap(function tick () { return 1; }, ctx);
	for (let i = 0; i < n; i++) {
		fn();
	}
}

function hammerAndDrop (n: number): void {
	for (let i = 0; i < n; i++) {
		const tmp = { marker : 'tmp' };
		const fn = wrap(function tick () { return 1; }, tmp);
		fn();
	}
}

describe('long-lived object probe: does the chain behind one object grow with every call?', () => {
	beforeEach(() => {
		clear();
	});

	it('100k finished calls on one held object: chainDepth(obj) === CALLS, alive === CALLS after GC', async () => {
		const service = { id: 'svc' };
		hammer(service, CALLS);
		await forceGcRounds(3);
		const depth = chainDepth(service);
		const alive = stats.alive;
		const collected = stats.collectedEdges;
		const heapMB = (process.memoryUsage().heapUsed / 1048576).toFixed(1);
		console.log(`long-lived: chainDepth=${depth} alive=${alive} collectedEdges=${collected} heap=${heapMB}MB after ${CALLS} calls`);
		expect(depth).toBe(CALLS);
		expect(alive).toBe(CALLS);
		expect(collected).toBe(0);
	}, 120_000);

	it('negative control: fresh short-lived object per call — chains collect after GC', async () => {
		hammerAndDrop(CALLS);
		await forceGcRounds(3);
		const alive = stats.alive;
		const collected = stats.collectedEdges;
		const heapMB = (process.memoryUsage().heapUsed / 1048576).toFixed(1);
		console.log(`short-lived: alive=${alive} collectedEdges=${collected} heap=${heapMB}MB after ${CALLS} calls`);
		expect(collected).toBeGreaterThan(CALLS * 0.9);
		expect(alive).toBeLessThan(CALLS * 0.1);
	}, 120_000);

	it('row 3: 100k calls on one held object → newest edge .drop(obj) → GC (object stays held)', async () => {
		const service = { id: 'svc' };
		hammer(service, CALLS);
		const E = getFlow(service)[CALLS - 1]; // newest edge, a copy
		E.drop(service); // targeted: svc unnamed + unanchored; links stay
		const depthAfterDrop = chainDepth(service);
		await forceGcRounds(3);
		const alive = stats.alive;
		const collected = stats.collectedEdges;
		const heapMB = (process.memoryUsage().heapUsed / 1048576).toFixed(1);
		// the next call starts a fresh story on the still-held object
		const fn = wrap(function tick () { return 1; }, service);
		fn();
		const nextDepth = chainDepth(service);
		console.log(`drop(obj): chainDepthAfterDrop=${depthAfterDrop} alive=${alive} collectedEdges=${collected} heap=${heapMB}MB nextCallDepth=${nextDepth} after ${CALLS} calls`);
		expect(depthAfterDrop).toBe(0);
		expect(collected).toBe(CALLS);
		expect(alive).toBe(0);
		expect(nextDepth).toBe(1);
	}, 120_000);

	it('row 4: 100k calls on one held object → newest edge .drop() → GC (object stays held)', async () => {
		const service = { id: 'svc' };
		hammer(service, CALLS);
		const E = getFlow(service)[CALLS - 1];
		E.drop(); // whole-trace wipe
		expect(getFlow(E)).toHaveLength(1); // before GC: just [E]
		const depthAfterDrop = chainDepth(service);
		await forceGcRounds(3);
		const alive = stats.alive;
		const collected = stats.collectedEdges;
		const heapMB = (process.memoryUsage().heapUsed / 1048576).toFixed(1);
		const fn = wrap(function tick () { return 1; }, service);
		fn();
		const nextDepth = chainDepth(service);
		console.log(`drop(): chainDepthAfterDrop=${depthAfterDrop} alive=${alive} collectedEdges=${collected} heap=${heapMB}MB nextCallDepth=${nextDepth} after ${CALLS} calls`);
		expect(depthAfterDrop).toBe(0);
		expect(collected).toBe(CALLS);
		expect(alive).toBe(0);
		expect(nextDepth).toBe(1);
	}, 120_000);
});

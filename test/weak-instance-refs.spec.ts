/**
 * Weak instance refs (Viktor's fiber model, 2026-09-02 —
 * reports/lastcontext-ambiguity.md).
 *
 * The semantics under test:
 *
 *   - DEFAULT (since 2026-09-02) is WEAK mode: edge.instance is a
 *     WeakRef deref; once nothing else holds the instance, GC collects
 *     it, the getter returns undefined, and the FinalizationRegistry
 *     marks the edge instanceCollected
 *   - setWeakInstanceRefs(false) is the strong opt-out: the ring pins
 *     instances — edge.instance stays reachable across forced GC (this
 *     is what memory experiment 1 measured: zero release after load)
 *   - the notification counter is observable (getCollectedInstanceCount)
 *   - clear() restores the weak default and resets the counter
 *
 * Requires --expose-gc (the test script sets NODE_OPTIONS accordingly).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
	recordCreation,
	enterContext,
	getTrace,
	clear,
	setWeakInstanceRefs,
	getCollectedInstanceCount,
} from '../src/index.js';
import type { FlowEdge } from '../src/index.js';

const gcOf = globalThis as typeof globalThis & { gc?: () => void };

// Read deref results ONLY inside a dedicated frame: a deref'd instance
// held by the test function's own frame would survive GC and falsify the
// whole test. A helper frame dies after the boolean crosses.
function isInstanceAlive (edge: FlowEdge): boolean {
	const result = edge.instance !== undefined;
	return result;
}

// Instance creation for weak-mode tests lives ONLY in a plain sync
// helper: its frame pops on return, so nothing above it can retain the
// instance. Creating inside the async test body risks the suspended
// frame's slots (post-inlining) being scanned as live roots — observed
// empirically: identical code collected standalone in 200ms but never
// inside vitest's async test frame (2026-09-02).
function createAndDrop (name: string): void {
	const instance = { marker : name };
	recordCreation(name, instance);
	enterContext(undefined);
}

function forceGc (): void {
	if (typeof gcOf.gc !== 'function') {
		throw new Error('weak-refs tests require node --expose-gc (NODE_OPTIONS=--expose-gc)');
	}
	gcOf.gc();
}

async function collectUntil (predicate: () => boolean, attempts = 60): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		forceGc();
		// FinalizationRegistry callbacks fire on a LATER task, not during gc()
		await new Promise((resolve) => {
			setTimeout(resolve, 25);
		});
		if (predicate()) {
			const result = true;
			return result;
		}
	}
	const result = false;
	return result;
}

/**
 * Poll for instance collection WITHOUT ever dereferencing inside a
 * suspended async frame. Probed empirically (2026-09-02): an
 * `edge.instance !== undefined` read inside an `async` test body pins the
 * instance for the frame's whole lifetime — V8 scans the suspended
 * frame's slots as live roots, so 30 gc() cycles collected nothing;
 * the same code polling from SYNC setInterval frames collects in 2 ticks.
 * Every frame this timer's callback runs in pops cleanly.
 */
function awaitInstanceCollected (edge: FlowEdge, attempts = 60): Promise<boolean> {
	const result = new Promise<boolean>((resolve) => {
		let tick = 0;
		const timer = setInterval(() => {
			forceGc();
			tick++;
			const gone = !isInstanceAlive(edge);
			if (gone || tick >= attempts) {
				clearInterval(timer);
				resolve(gone);
			}
		}, 25);
	});
	return result;
}

describe('weak instance refs', () => {

	beforeEach(() => {
		clear();
	});

	it('the DEFAULT mode is weak: GC releases the instance, marks the edge, keeps the skeleton', async () => {
		forceGc();
		const countBefore = getCollectedInstanceCount();
		createAndDrop('WeakThing');
		const edge = getTrace().find(item => item.name === 'WeakThing');
		expect(edge).toBeDefined();
		// Copy semantics, empirically pinned 2026-09-02: getTrace() copies
		// are SNAPSHOTS for data props — instanceCollected lands on the
		// LIVE edge and a pre-fetched copy never learns it — but the
		// instance getter is shared with the live edge, so its deref going
		// dead IS visible through the copy. Poll from sync frames only
		// (see awaitInstanceCollected), then re-fetch for the flag.
		const collected = await awaitInstanceCollected(edge!);
		expect(collected).toBe(true);
		// The WeakRef clearing and the registry callback are SEPARATE
		// tasks — the getter is already dead while the notification is
		// still queued. Await the counter on its own (counter reads never
		// deref, so an async-frame predicate is safe here).
		const notified = await collectUntil(() => getCollectedInstanceCount() > countBefore);
		expect(notified).toBe(true);
		const fresh = getTrace().find(item => item.name === 'WeakThing');
		expect(fresh!.instanceCollected).toBe(true);
		expect(fresh!.kind).toBe('create');
		expect(fresh!.status).toBe('ok');
		expect(fresh!.name).toBe('WeakThing');
	});

	it('strong opt-out keeps the instance reachable through the edge', async () => {
		forceGc();
		setWeakInstanceRefs(false);
		createAndDrop('StrongThing');
		const edge = getTrace().find(item => item.name === 'StrongThing');
		expect(edge).toBeDefined();
		// a negative assertion needs real GC pressure: poll several ticks,
		// the pinned instance must survive all of them (single gc() calls
		// do not reliably clear WeakRefs — that flakiness is exactly why
		// the polling helpers exist)
		const stillAlive = await collectUntil(() => {
			forceGc();
			const result = !isInstanceAlive(edge!);
			return result;
		}, 10);
		expect(stillAlive).toBe(false);
		expect(isInstanceAlive(edge!)).toBe(true);
		expect(edge!.instanceCollected).toBeUndefined();
	});

	it('clear() restores the weak default and resets the counter', async () => {
		forceGc();
		setWeakInstanceRefs(false);
		clear();
		expect(getCollectedInstanceCount()).toBe(0);
		// weak again: a fresh edge loses its instance to GC
		createAndDrop('AfterReset');
		const edge = getTrace().find(item => item.name === 'AfterReset');
		expect(edge).toBeDefined();
		const collected = await awaitInstanceCollected(edge!);
		expect(collected).toBe(true);
	});
});

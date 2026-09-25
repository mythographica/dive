/**
 * Collection proof (the GC contract — AGENTS.md "settled facts").
 *
 * The GC contract, proved end to end:
 *
 *   1. finished fibers COLLECT: stats.alive falls back to stats.running
 *      and stats.collectedEdges grows — nothing roots a settled edge once
 *      its instance dies (latestEdges and parents are WeakMaps)
 *   2. a PENDING fiber's chain SURVIVES the same GC — runningEdges is the
 *      one strong root dive owns, and a live edge keeps its ancestors
 *      (parents: child key alive → parent value alive) — then collects
 *      once released
 *   3. a HELD Error's chain SURVIVES the same GC — pinError puts the edge
 *      OBJECT on the Error — then collects once the Error is dropped
 *
 * All assertions are counter-based or read through copies: nothing here
 * derefs an instance inside a suspended async frame (the documented
 * frame-pinning trap, weak-instance-refs.spec.ts).
 *
 * Requires --expose-gc (the test script sets NODE_OPTIONS accordingly).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
	recordCreation,
	enterContext,
	wrap,
	getFlow,
	getErrorInstance,
	clear,
	stats,
} from '../src/index.js';

const gcOf = globalThis as typeof globalThis & { gc?: () => void };

function forceGc (): void {
	if (typeof gcOf.gc !== 'function') {
		throw new Error('collection-proof tests require node --expose-gc (NODE_OPTIONS=--expose-gc)');
	}
	gcOf.gc();
}

// Counter predicates never deref an instance, so polling them from the
// async test frame is safe (see weak-instance-refs.spec.ts for why the
// deref-in-async-frame trap does not apply to plain number reads).
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

// Survival rounds: force GC several times WITHOUT expecting collection;
// the assertion afterwards is that the counters did NOT move.
async function gcRounds (rounds: number): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		forceGc();
		await new Promise((resolve) => {
			setTimeout(resolve, 25);
		});
	}
}

// A finished fiber = a create edge + a sync call edge, both settled, made
// inside a plain sync helper: its frame pops on return, so nothing above
// it can retain the instance OR the edges. Creating inside the async test
// body risks the suspended frame's slots being scanned as live roots.
function runFinishedFibers (count: number): void {
	for (let i = 0; i < count; i++) {
		const ctx = { marker : i };
		recordCreation('Fiber', ctx);
		wrap(function work () {
			return i;
		}, ctx)();
		enterContext(undefined);
	}
}

// A pending fiber: the wrapped async fn awaits a gate the caller holds.
// The helper returns ONLY the release function — the running call edge is
// rooted by runningEdges, the create edge by the parents map (child key →
// parent value), and the gate keeps the suspended activation. Nothing
// else may escape this frame.
function startPendingFiber (): () => void {
	const ctx = { name : 'pending' };
	recordCreation('PendingCtx', ctx);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = wrap(async function pendingFiber () {
		await gate;
		return 1;
	}, ctx);
	pending();
	enterContext(undefined);
	const result = release;
	return result;
}

// A failing fiber: create + wrap + throw inside a sync helper that
// returns ONLY the Error (the trap object-links.spec.ts documents).
// pinError puts the failing edge OBJECT on the Error, so holding the
// Error holds the edge — and the parents map holds the chain behind it.
function failAndReturnError (): Error {
	const ctx = { request : 6 };
	recordCreation('FailingCtx', ctx);
	const failing = wrap(function failingCall (): never {
		throw new Error('boom');
	}, ctx);
	let caught: Error | undefined;
	try {
		failing();
	} catch (error) {
		caught = error as Error;
	}
	enterContext(undefined);
	const result = caught!;
	return result;
}

// Dropping the held Error must happen in a sync helper too: reassigning a
// local in the suspended async frame may keep the slot alive (same trap).
function dropBoxedError (box: { current: Error | undefined }): void {
	box.current = undefined;
}

// Reading the pinned chain must happen in a sync helper as well: getFlow's
// copies and getErrorInstance's LIVE instance all die with this frame; only
// plain data (a length, a shallow copy) escapes into the async test frame.
function observeHeldError (box: { current: Error | undefined }): { flowLength: number; instance: object | undefined } {
	const error = box.current!;
	const flowLength = getFlow(error).length;
	const pinned = getErrorInstance(error);
	const instance: object | undefined = pinned === undefined ? undefined : { ...pinned };
	const result = { flowLength, instance };
	return result;
}

describe('collection proof (step 6)', () => {

	beforeEach(() => {
		clear();
		forceGc();
	});

	it('finished fibers collect: alive falls back to running, collectedEdges grows', async () => {
		const fibers = 50;
		runFinishedFibers(fibers);
		expect(stats.recorded).toBe(fibers * 2);
		expect(stats.running).toBe(0);
		const drained = await collectUntil(() => {
			const result = stats.alive === stats.running &&
				stats.collectedEdges === fibers * 2 &&
				stats.collectedInstances === fibers;
			return result;
		});
		expect(drained).toBe(true);
		expect(stats.alive).toBe(0);
		expect(stats.collectedEdges).toBe(fibers * 2);
		expect(stats.collectedInstances).toBe(fibers);
	});

	it('a pending fiber keeps its whole chain across GC, then collects once released', async () => {
		const release = startPendingFiber();
		expect(stats.recorded).toBe(2);
		expect(stats.running).toBe(1);
		// survival: five GC rounds must NOT move the counters — the running
		// edge is strong-rooted and keeps its ancestor through the parents map
		await gcRounds(5);
		expect(stats.collectedEdges).toBe(0);
		expect(stats.alive).toBe(2);
		expect(stats.running).toBe(1);
		// release: the gate resolves, the tap settles the edge, the cascade
		// unroots — child first, then the parent it was keeping alive
		release();
		const drained = await collectUntil(() => {
			const result = stats.running === 0 && stats.collectedEdges === 2 && stats.alive === 0;
			return result;
		});
		expect(drained).toBe(true);
	});

	it('a held Error keeps its whole chain across GC, then collects once dropped', async () => {
		const box: { current: Error | undefined } = { current : failAndReturnError() };
		const observed = observeHeldError(box);
		// the chain is readable through the pin — but every read lives in a
		// sync helper frame: an Error-holding local in THIS async frame once
		// rooted the whole chain and failed this very test (first run)
		expect(observed.flowLength).toBeGreaterThan(0);
		expect(observed.instance).toEqual({ request : 6 });
		expect(stats.recorded).toBe(2);
		expect(stats.running).toBe(0);
		// survival: the pinned edge is held BY the Error, the parent by the map
		await gcRounds(5);
		expect(stats.collectedEdges).toBe(0);
		expect(stats.alive).toBe(2);
		// released: the Error collects, the pin dies with it, the chain follows
		dropBoxedError(box);
		const drained = await collectUntil(() => {
			const result = stats.collectedEdges === 2 && stats.alive === 0;
			return result;
		});
		expect(drained).toBe(true);
	});
});

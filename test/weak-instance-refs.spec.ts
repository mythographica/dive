/**
 * Weak instance refs (Viktor's fiber model — evidence in
 * reports/lastcontext-ambiguity.md).
 *
 * The semantics under test:
 *
 *   - edges are WEAK only (weak refs are the only mode — AGENTS.md
 *     "settled facts"): edge.instance is a WeakRef
 *     deref; once nothing else holds the instance, GC collects it, the
 *     getter returns undefined and instanceCollected turns true
 *   - the notification counter is observable (stats.collectedInstances)
 *   - clear() resets the counter
 *
 * Requires --expose-gc (the test script sets NODE_OPTIONS accordingly).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
	recordCreation,
	enterContext,
	registerHook,
	clear,
	stats,
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
// empirically: identical code collects standalone in ~200ms but never
// inside vitest's async test frame.
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
 * suspended async frame. Probed empirically: an
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

	it('GC releases the instance, the edge reports it collected, the skeleton stays', async () => {
		forceGc();
		const countBefore = stats.collectedInstances;
		// the create hook hands over the LIVE edge: the WeakRef going dead AND
		// instanceCollected are both visible through its getters (there is no
		// whole-trace copy list — hooks are the observation surface)
		const seen: FlowEdge[] = [];
		registerHook('create', ({ edge }) => {
			seen.push(edge);
		});
		createAndDrop('WeakThing');
		const edge = seen.find(item => item.name === 'WeakThing');
		expect(edge).toBeDefined();
		// Poll from sync frames only (see awaitInstanceCollected).
		const collected = await awaitInstanceCollected(edge!);
		expect(collected).toBe(true);
		expect(edge!.instanceCollected).toBe(true);
		// The WeakRef clearing and the registry callback are SEPARATE
		// tasks — the getter is already dead while the notification is
		// still queued. Await the counter on its own (counter reads never
		// deref, so an async-frame predicate is safe here).
		const notified = await collectUntil(() => stats.collectedInstances > countBefore);
		expect(notified).toBe(true);
		expect(edge!.kind).toBe('create');
		expect(edge!.status).toBe('ok');
		expect(edge!.name).toBe('WeakThing');
	});

	it('clear() resets the counter; fresh edges stay weak', async () => {
		forceGc();
		clear();
		expect(stats.collectedInstances).toBe(0);
		const seen: FlowEdge[] = [];
		registerHook('create', ({ edge }) => {
			seen.push(edge);
		});
		createAndDrop('AfterReset');
		const edge = seen.find(item => item.name === 'AfterReset');
		expect(edge).toBeDefined();
		const collected = await awaitInstanceCollected(edge!);
		expect(collected).toBe(true);
	});
});

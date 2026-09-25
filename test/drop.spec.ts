/**
 * edge.drop(...targets) — explicit trace eviction, walked from the edge UP
 * to the root (E → parents.get(E) → … → root). FINAL spec:
 *
 *   E.drop()         — wipe the whole trace: every edge on the walk loses
 *                      its parent link, its object anchor (latestEdges),
 *                      and its instance ref; running edges leave the
 *                      running store; the cursor is released when it
 *                      points into the trace. After it getFlow(E) is just
 *                      [E] and everything collects once nothing outside
 *                      holds it. Price: an Error pinned to any edge of
 *                      the trace keeps ONLY its own edge.
 *   E.drop(o1, o2,…) — same walk, only the given objects removed: where an
 *                      edge's instance is oN that edge's instance ref is
 *                      cleared; where latestEdges.get(oN) is the edge the
 *                      anchor is deleted. Edges and parent links stay;
 *                      other objects, siblings, successors untouched.
 *
 * Copies from getFlow()/getRunningEdges() resolve to their live edge via a
 * weak side-link (copies never pin the trace — the shared WeakRef is never
 * cleared, only the per-edge field). Non-object args are ignored and are
 * NOT a wipe; calling twice is a no-op.
 *
 * Requires --expose-gc (the test script sets NODE_OPTIONS accordingly).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	wrap,
	recordCreation,
	registerHook,
	stats,
	chainDepth,
	getFlow,
	getRunningEdges,
	clear,
} from '../src/index.js';
import type { FlowEdge } from '../src/index.js';

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

// sync helper — no suspended async frame may scan locals as live roots
// (the documented frame-pinning trap — weak-instance-refs.spec.ts)
function hammer (ctx: object, n: number): void {
	const fn = wrap(function tick () { return 1; }, ctx);
	for (let i = 0; i < n; i++) {
		fn();
	}
}

describe('edge.drop(): explicit trace eviction', () => {
	beforeEach(() => {
		clear();
	});

	it('E.drop() wipes the whole trace: getFlow(E) is just [E], everything collects', async () => {
		const svc = { id: 'svc' };
		hammer(svc, 10);
		const E = getFlow(svc)[9]; // a COPY — must resolve to the live edge
		E.drop();
		expect(getFlow(E)).toHaveLength(1);
		expect(chainDepth(svc)).toBe(0);
		await forceGcRounds(3);
		expect(stats.collectedEdges).toBe(10);
		expect(stats.alive).toBe(0);
	});

	it('after E.drop() an Error pinned to the trace keeps ONLY its own edge', async () => {
		const svc = { id: 'svc' };
		const failing = wrap(function failing () {
			throw new Error('boom');
		}, svc);
		let err: Error | null = null;
		try {
			failing();
		} catch (e) {
			err = e as Error;
		}
		hammer(svc, 5); // 6 edges total; the failure pinned the deepest one
		const E = getFlow(svc)[5];
		E.drop();
		await forceGcRounds(3);
		// the pin still holds the failing edge itself — but no parents
		expect(getFlow(err as unknown as Error)).toHaveLength(1);
		expect(stats.alive).toBe(1);
		expect(stats.collectedEdges).toBe(5);
	});

	it('E.drop(obj) unanchors and unnames only that object — edges, links, others intact', async () => {
		const svc = { id: 'svc' };
		const other = { id: 'other' };
		const live: FlowEdge[] = [];
		registerHook('enter', ({ edge }) => {
			live.push(edge); // LIVE edge objects — the only way to observe renaming
		});
		const inner = wrap(function inner () { return 1; }, svc);
		const outer = wrap(function outer () { inner(); }, other);
		outer(); // trace: call:outer(other) → call:inner(svc)
		expect(chainDepth(other)).toBe(1);
		live[1].drop(svc); // E = the inner edge, live
		// svc: unanchored (no continuation point) and unnamed (live ref cleared)
		expect(chainDepth(svc)).toBe(0);
		expect(live[1].instance).toBeUndefined();
		// other: fully intact — named, anchored, same depth
		expect(live[0].instance).toBe(other);
		expect(chainDepth(other)).toBe(1);
		await forceGcRounds(3);
		// NB: the `live` array intentionally pins the inner edge (holding a
		// live edge is the only way to observe renaming) — so nothing here
		// collects; the collection side is covered by the wipe tests
		expect(stats.collectedEdges).toBe(0);
		expect(stats.alive).toBe(2);
	});

	it('E.drop(rootObj) leaves successor-bound objects alive — unnamed, unanchored, but linked', async () => {
		const root = { id: 'root' };
		const child = { id: 'child' };
		const liveCreate: FlowEdge[] = [];
		registerHook('create', ({ edge }) => {
			liveCreate.push(edge);
		});
		recordCreation('Root', root);
		recordCreation('Child', child, root);
		hammer(child, 3); // depth 5: 3 calls + Child + Root
		const E = getFlow(child)[4];
		E.drop(root);
		// root's create edge: unnamed + unanchored…
		expect(liveCreate[0].instance).toBeUndefined();
		expect(chainDepth(root)).toBe(0);
		// …but the successor chain keeps it alive as a parent — depth unchanged
		expect(liveCreate[1].instance).toBe(child);
		expect(chainDepth(child)).toBe(5);
		await forceGcRounds(3);
		expect(stats.alive).toBe(5);
		expect(stats.collectedEdges).toBe(0);
	});

	it('a running edge in the wiped trace leaves the running store; the call still settles', async () => {
		const svc = { id: 'svc' };
		const slow = wrap(function slow () {
			return new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
		}, svc);
		const pending = slow();
		await sleepTick();
		expect(stats.running).toBe(1);
		const E = getRunningEdges()[0]; // copy of the running edge
		E.drop();
		expect(stats.running).toBe(0);
		await pending; // settles honestly even though its edge left the store
		await forceGcRounds(3);
		expect(stats.alive).toBe(0);
		expect(stats.collectedEdges).toBe(1);
	});

	it('non-object args are ignored and are NOT a wipe; double drop is a no-op', async () => {
		const svc = { id: 'svc' };
		hammer(svc, 5);
		const E = getFlow(svc)[4];
		E.drop(42, null, 'svc');
		expect(chainDepth(svc)).toBe(5); // untouched — NOT a wipe
		const unrelated = { id: 'unrelated' };
		E.drop(unrelated); // nothing on the trace anchors it — memory stays held
		expect(chainDepth(svc)).toBe(5);
		// an object anchored on a DIFFERENT trace keeps its anchor when
		// dropped from this one — the anchor delete is scoped to where
		// latestEdges.get(oN) === edge (negative control for that scoping)
		const offTrace = { id: 'off' };
		hammer(offTrace, 3);
		E.drop(offTrace); // offTrace's anchor is NOT on svc's walked trace
		expect(chainDepth(offTrace)).toBe(3);
		expect(chainDepth(svc)).toBe(5);
		E.drop(svc); // targeted: only svc may be touched
		expect(chainDepth(offTrace)).toBe(3);
		expect(chainDepth(svc)).toBe(0);
		E.drop(); // the actual wipe — offTrace still untouched
		expect(chainDepth(offTrace)).toBe(3);
		expect(getFlow(E)).toHaveLength(1); // before GC: just [E]
		E.drop(); // no-op second time
		await forceGcRounds(3);
		// 8 recorded: svc's 5 die with the wipe; offTrace's 3 survive on it
		expect(stats.collectedEdges).toBe(5);
		expect(stats.alive).toBe(3);
	});
});

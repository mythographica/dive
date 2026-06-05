/**
 * REAL head-to-head: ALS vs dive — honest in BOTH directions.
 *
 * Unlike als-comparison.spec.ts (whose assertions are tautological or mislabel
 * ALS *working* as ALS failing), these tests reproduce the actual mechanics and
 * encode what was observed — including the case where ALS WINS. The point is
 * truth, not advocacy.
 *
 * Fixtures are kept SYMMETRIC: both arms are given the same information at
 * consume time (only a bare uuid string). Asymmetric fixtures — handing one
 * side richer data — are exactly how the original suite faked its results.
 *
 * Mechanism summary:
 *   - ALS keys context by ASYNC RESOURCE  -> dies when the request scope exits.
 *   - dive keys context by USERLAND OBJECT (link map / object reference)
 *     -> survives, because the object outlives the async resource.
 *   - dive's bare `lastContext` is a single module-global -> clobbered by
 *     concurrent flows UNLESS you capture per-flow context with wrap().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getLastContext, setLastContext, link, wrap, clear } from '../src/index.js';

describe('decoupled queue: recover origin from a BARE identifier', () => {
	beforeEach(() => clear());

	// Both arms enqueue ONLY the uuid string — as if it were a uuid in a log
	// line or a DB row, with the originating object long out of scope. This is
	// the realistic case and keeps the comparison fair.

	it('ALS cannot map a bare uuid back to its origin after the request ends', async () => {
		const als = new AsyncLocalStorage<{ requestId: string }>();
		const queue: string[] = [];

		als.run({ requestId: 'req-A' }, () => {
			for (let i = 0; i < 5; i++) {
				queue.push(`req-A-${i}`); // only the uuid leaves the request
			}
		});

		const recovered: (string | undefined)[] = [];
		await new Promise<void>((resolve) => setTimeout(() => {
			for (const _uuid of queue) {
				// consumer holds only the uuid; ALS has no ambient store here
				recovered.push(als.getStore()?.requestId);
			}
			resolve();
		}, 5));

		expect(recovered).toEqual([undefined, undefined, undefined, undefined, undefined]);
	});

	it('dive maps a bare uuid back to its origin via the link map', async () => {
		const queue: string[] = [];
		const requestId = 'req-A';

		for (let i = 0; i < 5; i++) {
			const uuid = `${requestId}-${i}`;
			const instance = { uuid, requestId, payload: i };
			link(instance, uuid); // pin object to identifier
			queue.push(uuid);      // enqueue ONLY the uuid; object goes out of scope
		}

		const recovered: (string | undefined)[] = [];
		await new Promise<void>((resolve) => setTimeout(() => {
			for (const uuid of queue) {
				// consumer holds only the uuid — recovers the object via the map
				const ctx = getLastContext(uuid) as { requestId: string } | undefined;
				recovered.push(ctx?.requestId);
			}
			resolve();
		}, 5));

		expect(recovered).toEqual(['req-A', 'req-A', 'req-A', 'req-A', 'req-A']);
	});
});

describe('concurrent flows: ALS auto-isolates; dive needs wrap()', () => {
	beforeEach(() => clear());

	it('ALS isolates two interleaved async flows automatically', async () => {
		const als = new AsyncLocalStorage<{ id: string }>();
		const out: Record<string, string | undefined> = {};

		await Promise.all([
			new Promise<void>((res) => als.run({ id: 'A' }, () => setTimeout(() => {
				out.A = als.getStore()?.id;
				res();
			}, 15))),
			new Promise<void>((res) => als.run({ id: 'B' }, () => setTimeout(() => {
				out.B = als.getStore()?.id;
				res();
			}, 5))),
		]);

		expect(out).toEqual({ A: 'A', B: 'B' });
	});

	it("dive's bare global lastContext IS clobbered by interleaving (no wrap)", async () => {
		const out: Record<string, unknown> = {};

		await Promise.all([
			(async () => {
				setLastContext({ id: 'A' });
				await new Promise((r) => setTimeout(r, 15));
				out.A = (getLastContext() as { id: string } | undefined)?.id;
			})(),
			(async () => {
				setLastContext({ id: 'B' });
				await new Promise((r) => setTimeout(r, 5));
				out.B = (getLastContext() as { id: string } | undefined)?.id;
			})(),
		]);

		// Both reads see the LAST writer's value: the single module-global cannot
		// isolate concurrent flows on its own. This is dive's real limitation.
		expect(out.A).toBe(out.B);
	});

	it('dive wrap() DOES isolate concurrent flows when captured synchronously', async () => {
		const out: Record<string, unknown> = {};

		await Promise.all([
			(async () => {
				setLastContext({ id: 'A' });
				// capture context into the closure synchronously, before any await
				const cb = wrap(() => (getLastContext() as { id: string } | undefined)?.id);
				await new Promise((r) => setTimeout(r, 15));
				out.A = cb();
			})(),
			(async () => {
				setLastContext({ id: 'B' });
				const cb = wrap(() => (getLastContext() as { id: string } | undefined)?.id);
				await new Promise((r) => setTimeout(r, 5));
				out.B = cb();
			})(),
		]);

		// With per-flow wrap(), each closure restores its OWN captured context.
		// dive matches ALS's isolation here — at the cost of explicit ceremony.
		expect(out.A).toBe('A');
		expect(out.B).toBe('B');
	});
});

/**
 * The canonical motivating case from nodejs/diagnostics#249 — a "synchronous
 * context split": a callback is pushed to a queue and drained LATER by a
 * setInterval (a different async resource). The maintainers acknowledge
 * async_hooks/ALS cannot bridge this without patching libraries. dive's wrap()
 * is precisely the answer: capture the context into the closure at push time.
 *
 *   const queueArray = [];
 *   setInterval(() => { queueArray.forEach(task => task()); }, 1000);
 *   FunctionWhereTrackingStarts = () => {
 *     queueArray.push(() => { ...cannot reach original context here... });
 *   };
 */
describe('nodejs/diagnostics#249: callback pushed to a setInterval-drained queue', () => {
	beforeEach(() => clear());

	it('ALS: queued callback loses context — it runs in the setInterval tick', async () => {
		const als = new AsyncLocalStorage<{ id: string }>();
		const queue: Array<() => void> = [];
		let seen: string | undefined = 'UNSET';

		// the drainer is established OUTSIDE any als.run — a separate async resource
		const result = await new Promise<string | undefined>((resolve) => {
			const timer = setInterval(() => {
				const task = queue.shift();
				if (task) {
					task();
					clearInterval(timer);
					resolve(seen);
				}
			}, 10);

			// FunctionWhereTrackingStarts: runs in a logical context, queues a task
			als.run({ id: 'logical-A' }, () => {
				queue.push(() => { seen = als.getStore()?.id; });
			});
		});

		expect(result).toBeUndefined(); // ALS cannot bridge the sync context split
	});

	it('dive: wrap() carries the logical context into the queued callback', async () => {
		const queue: Array<() => void> = [];
		let seen: string | undefined = 'UNSET';

		const result = await new Promise<string | undefined>((resolve) => {
			const timer = setInterval(() => {
				const task = queue.shift();
				if (task) {
					task();
					clearInterval(timer);
					resolve(seen);
				}
			}, 10);

			// FunctionWhereTrackingStarts: set context, wrap the queued callback
			setLastContext({ id: 'logical-A' });
			queue.push(wrap(() => {
				seen = (getLastContext() as { id: string } | undefined)?.id;
			}));
			clear(); // even with global context wiped, the closure kept its capture
		});

		expect(result).toBe('logical-A'); // dive bridges the split via the closure
	});
});

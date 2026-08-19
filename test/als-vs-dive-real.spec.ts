/**
 * REAL head-to-head: ALS vs dive — honest in BOTH directions.
 *
 * These tests reproduce the actual mechanics and encode what was observed —
 * including the case where ALS WINS. The point is truth, not advocacy.
 *
 * Mechanism summary:
 *   - ALS keys context by ASYNC RESOURCE  -> dies when the request scope exits.
 *   - dive keys context by USERLAND OBJECT -> survives, because the object
 *     outlives the async resource. In the redesigned dive there is not even a
 *     lookup map: the failing data IS pinned to the error, with its flow trace.
 *   - dive's bare current() is a single module-global switcher -> newest-wins
 *     under interleaving. The TRACE (getFlow) is what isolates concurrent
 *     flows; current() is a convenience for single-flow code.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTypesCollection } from 'mnemonica/module';
import { attachHooks, wrap, current, getErrorInstance, getFlow, clear } from '../src/index.js';

describe('decoupled queue: recover origin after the request ends', () => {
	beforeEach(() => clear());

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

	it('dive recovers the origin from the ERROR itself — no identifier map needed', async () => {
		// The old dive mapped bare uuids through a side map (link/unlink), with a
		// leak caveat. The redesign answers the Goal directly: when the consumer
		// FAILS, the data that caused it is pinned to the error, with its flow.
		const queue: { uuid: string; requestId: string; payload: number }[] = [];

		for (let i = 0; i < 5; i++) {
			queue.push({ uuid: `req-A-${i}`, requestId: 'req-A', payload: i });
		}

		const recovered: (string | undefined)[] = [];
		await new Promise<void>((resolve) => setTimeout(() => {
			for (const instance of queue) {
				try {
					// the consumer processes each instance at a decoupled boundary…
					wrap(() => {
						throw new Error(`processing failed: ${instance.uuid}`);
					}, instance)();
				} catch (err) {
					// …and the failure itself carries the origin — no map, no uuid lookup
					const origin = getErrorInstance(err as Error) as { requestId: string } | undefined;
					recovered.push(origin?.requestId);
				}
			}
			resolve();
		}, 5));

		expect(recovered).toEqual(['req-A', 'req-A', 'req-A', 'req-A', 'req-A']);
	});
});

describe('concurrent flows: ALS auto-isolates; the dive TRACE isolates', () => {
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

	it("dive's bare current() IS newest-wins under interleaving (documented)", async () => {
		const collection = createTypesCollection();
		attachHooks(collection);
		const Entity = collection.define('Entity', function (this: { id: string }, id: string) {
			this.id = id;
		});

		new Entity('A');
		const b = new Entity('B');

		// the switcher holds the LAST thing that happened — nothing isolates it
		expect(current()).toBe(b);
	});

	it('the dive trace isolates interleaved flows structurally', async () => {
		const out: Record<string, unknown> = {};
		const a = { id: 'A' };
		const b = { id: 'B' };

		await Promise.all([
			(async () => {
				const cb = wrap(() => current(), a);
				await new Promise((r) => setTimeout(r, 15));
				out.A = (cb() as { id: string } | undefined)?.id;
			})(),
			(async () => {
				const cb = wrap(() => current(), b);
				await new Promise((r) => setTimeout(r, 5));
				out.B = (cb() as { id: string } | undefined)?.id;
			})(),
		]);

		// wrap() restores each closure's own capture — and the branches stay apart
		expect(out.A).toBe('A');
		expect(out.B).toBe('B');
		expect(getFlow(a).every((edge) => edge.instance === a)).toBe(true);
		expect(getFlow(b).every((edge) => edge.instance === b)).toBe(true);
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

			// FunctionWhereTrackingStarts: wrap the queued callback with the context
			const logicalContext = { id: 'logical-A' };
			queue.push(wrap(() => {
				seen = (current() as { id: string } | undefined)?.id;
			}, logicalContext));
			clear(); // even with ambient context wiped, the closure kept its capture
		});

		expect(result).toBe('logical-A'); // dive bridges the split via the closure
	});
});

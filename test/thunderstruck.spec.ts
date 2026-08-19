/**
 * Thunderstruck — the Ahead-of-Construction Data Collector.
 *
 * The contract (design report: core/reports/thunderstruck-pre-root-design.md):
 *
 *   feed(data)  → stash a pre-root payload ahead of construction, get a uuid
 *                 to correlate it through the invocation path (no ALS).
 *   .collected  → getter flushing everything fed and not yet released
 *                 (a Map copy, keyed by uuid) — a constructor picks its own
 *                 payload out during construction.
 *   release     → pending payloads are dropped at the next ROOT postCreation:
 *                 wired into the instance during construction = lives on with
 *                 the instance; otherwise dropped, no retention.
 *
 * These specs pin the subtleties:
 *   - a SUB-construction must NOT drain the pending store (a root constructor
 *     may build sub-instances before reading .collected);
 *   - async constructors: postCreation fires after the construction promise
 *     resolves, so pending payloads survive across awaits inside the body;
 *   - creationError does NOT release (the payload preceding a failure is
 *     exactly the data worth keeping);
 *   - the store is dive-global: feed works without attachHooks, and then
 *     nothing ever drains it until clear().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTypesCollection } from 'mnemonica/module';

import {
	attachHooks,
	thunderstruck,
	clear,
} from '../src/index.js';

describe('thunderstruck: feed + collected', () => {
	beforeEach(() => clear());

	it('feed returns distinct uuids; collected exposes both payloads by uuid', () => {
		const dataA = { body: { a: 1 } };
		const dataB = { query: { b: 2 } };

		const uuidA = thunderstruck.feed(dataA);
		const uuidB = thunderstruck.feed(dataB);

		expect(uuidA).toBeTypeOf('string');
		expect(uuidB).toBeTypeOf('string');
		expect(uuidA).not.toBe(uuidB);

		const pending = thunderstruck.collected;
		expect(pending.size).toBe(2);
		expect(pending.get(uuidA)).toBe(dataA);
		expect(pending.get(uuidB)).toBe(dataB);
	});

	it('collected returns a COPY — mutating it does not touch the store', () => {
		const uuid = thunderstruck.feed({ x: 1 });

		const first = thunderstruck.collected;
		first.delete(uuid);

		const second = thunderstruck.collected;
		expect(second.size).toBe(1);
		expect(second.get(uuid)).toEqual({ x: 1 });
	});

	it('feed works without attachHooks — nothing drains until clear()', () => {
		const uuid = thunderstruck.feed({ lonely: true });
		expect(thunderstruck.collected.get(uuid)).toEqual({ lonely: true });

		clear();
		expect(thunderstruck.collected.size).toBe(0);
	});
});

describe('thunderstruck: release at ROOT postCreation', () => {
	beforeEach(() => clear());

	it('a root construction releases pending payloads', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const Root = collection.define('Root', function (this: Record<string, unknown>) {
			this.kind = 'root';
		});

		const uuid = thunderstruck.feed({ body: { x: 1 } });
		expect(thunderstruck.collected.get(uuid)).toBeDefined();

		new Root();
		expect(thunderstruck.collected.size).toBe(0);
	});

	it('payload read inside the constructor lives on with the instance', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const payload = { body: { x: 1 }, query: { page: 2 } };
		const uuid = thunderstruck.feed(payload);

		let seenInside: unknown;
		const Root = collection.define('Root', function (this: Record<string, unknown>) {
			seenInside = thunderstruck.collected.get(uuid);
			this.preRoot = seenInside; // wire it: now it belongs to the instance
		});

		const root = new Root() as Record<string, unknown>;

		expect(seenInside).toBe(payload);
		expect(root.preRoot).toBe(payload); // lives on with the instance…
		expect(thunderstruck.collected.size).toBe(0); // …while dive released its copy
	});

	it('a SUB-construction does NOT drain; the next ROOT construction does', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const Parent = collection.define('Parent', function (this: Record<string, unknown>) {
			this.kind = 'parent';
		});
		Parent.define('Sub', function (this: Record<string, unknown>) {
			this.kind = 'sub';
		});

		const parent = new Parent(); // root construction, nothing pending yet

		const payload = { raw: 'request' };
		const uuid = thunderstruck.feed(payload);

		const sub = new parent.Sub(); // sub postCreation fires here…
		expect(sub).toBeDefined();
		expect(thunderstruck.collected.get(uuid)).toBe(payload); // …store intact

		new Parent(); // the next ROOT postCreation closes the window
		expect(thunderstruck.collected.size).toBe(0);
	});

	it('ALL pending payloads are released at the next root construction', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const Root = collection.define('Root', function (this: Record<string, unknown>) {
			this.kind = 'root';
		});

		thunderstruck.feed({ request: 'A' });
		thunderstruck.feed({ request: 'B' });
		expect(thunderstruck.collected.size).toBe(2);

		new Root();
		// The pre-root window is per-root-construction: whoever fed before it
		// had their chance to read during it; everything left is dropped.
		expect(thunderstruck.collected.size).toBe(0);
	});
});

describe('thunderstruck: async constructors + failures', () => {
	beforeEach(() => clear());

	it('pending survives across awaits inside the body, released after resolution', async () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const payload = { body: { deep: 'data' } };
		const uuid = thunderstruck.feed(payload);

		let seenBeforeAwait: unknown;
		let seenAfterAwait: unknown;
		// NOTE: async constructors must RETURN the instance (default
		// awaitReturn: true) for core to run post-processing — with
		// awaitReturn: false and no return, core fires no postCreation at all.
		const AsyncRoot = collection.define('AsyncRoot', async function (this: Record<string, unknown>) {
			seenBeforeAwait = thunderstruck.collected.get(uuid);
			await new Promise((resolve) => setTimeout(resolve, 10));
			// postCreation has NOT fired yet — the promise is still pending
			seenAfterAwait = thunderstruck.collected.get(uuid);
			this.preRoot = seenAfterAwait;
			return this;
		});

		const instance = await new AsyncRoot() as Record<string, unknown>;

		expect(seenBeforeAwait).toBe(payload);
		expect(seenAfterAwait).toBe(payload);
		expect(instance.preRoot).toBe(payload);
		// postCreation fired when the construction promise resolved —
		// by the time the outer await completed, dive already released
		expect(thunderstruck.collected.size).toBe(0);
	});

	it('creationError does NOT release — the payload survives the failure', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const payload = { body: { bad: 'input' } };
		const uuid = thunderstruck.feed(payload);

		const Failing = collection.define('Failing', function (this: Record<string, unknown>) {
			throw new Error('boom');
		});

		expect(() => new Failing()).toThrow('boom');
		expect(thunderstruck.collected.get(uuid)).toBe(payload);
	});
});

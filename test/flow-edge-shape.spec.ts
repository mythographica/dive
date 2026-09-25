/**
 * FlowEdge shape (the edge layout contract — AGENTS.md "settled facts").
 *
 *   - every edge keeps V8's FAST property layout: no per-edge
 *     defineProperty getter, all fields declared up front (a getter-plus-
 *     late-field layout lands in dictionary mode — a 448-byte property
 *     table per edge, measured in /code/experiments/2026-09-24-otel-soak-unbounded/)
 *   - instanceCollected is derived from the WeakRef itself: false while
 *     the instance lives, true once it is collected — no notification lag,
 *     visible on copies too
 *
 * Requires --expose-gc (the test script sets NODE_OPTIONS accordingly).
 */

import v8 from 'node:v8';
import { describe, it, expect, beforeEach } from 'vitest';

import {
	recordCreation,
	enterContext,
	wrap,
	getFlow,
	registerHook,
	clear,
} from '../src/index.js';
import type { FlowEdge } from '../src/index.js';

// %HasFastProperties needs natives syntax; NODE_OPTIONS rejects that flag,
// so it is switched on here, before the probe function is compiled
v8.setFlagsFromString('--allow-natives-syntax');
const hasFastProperties = new Function('value', 'return %HasFastProperties(value);') as (value: object) => boolean;

const gcOf = globalThis as typeof globalThis & { gc?: () => void };

// see weak-instance-refs.spec.ts: create and deref only in sync helper frames
function createAndDrop (name: string): void {
	const instance = { marker : name };
	recordCreation(name, instance);
	enterContext(undefined);
}

function createAndDropShared (name: string, times: number): void {
	const instance = { marker : name };
	for (let i = 0; i < times; i++) {
		recordCreation(name, instance);
	}
	enterContext(undefined);
}

// same sync-frame trap as createAndDrop: the returned copy is all that may
// escape — the instance itself stays frame-local and collectable
function createCopyAndDrop (name: string): FlowEdge {
	const instance = { marker : name };
	recordCreation(name, instance);
	enterContext(undefined);
	const result = getFlow(instance)[0];
	return result;
}

function isCollected (edge: FlowEdge): boolean {
	const result = edge.instanceCollected === true;
	return result;
}

function awaitCollected (edge: FlowEdge, attempts = 60): Promise<boolean> {
	const result = new Promise<boolean>((resolve) => {
		let tick = 0;
		const timer = setInterval(() => {
			gcOf.gc!();
			tick++;
			const gone = isCollected(edge);
			if (gone || tick >= attempts) {
				clearInterval(timer);
				resolve(gone);
			}
		}, 25);
	});
	return result;
}

describe('FlowEdge shape', () => {

	beforeEach(() => {
		clear();
	});

	it('create, call and running edges keep fast properties', () => {
		const ctx = { name : 'ctx' };
		// edges are observed live via the lifecycle hooks
		const seen: FlowEdge[] = [];
		registerHook('create', ({ edge }) => {
			seen.push(edge);
		});
		registerHook('enter', ({ edge }) => {
			seen.push(edge);
		});
		recordCreation('Made', { made : true });
		wrap(function fastCall () { return 1; }, ctx)();
		expect(seen.length).toBe(2);
		for (const edge of seen) {
			expect(hasFastProperties(edge)).toBe(true);
		}
	});

	it('instanceCollected is false while the instance lives', () => {
		const instance = { alive : true };
		recordCreation('Alive', instance);
		const edge = getFlow(instance).find((item) => item.name === 'Alive');
		expect(edge!.instanceCollected).toBe(false);
		expect(edge!.instance).toBe(instance);
	});

	it('edges sharing one instance (one shared WeakRef) all report it collected', async () => {
		const seen: FlowEdge[] = [];
		registerHook('create', ({ edge }) => {
			seen.push(edge);
		});
		createAndDropShared('Shared', 3);
		const shared = seen.filter((item) => item.name === 'Shared');
		expect(shared.length).toBe(3);
		const collected = await awaitCollected(shared[0]);
		expect(collected).toBe(true);
		expect(shared.map((edge) => edge.instanceCollected)).toEqual([ true, true, true ]);
	});

	it('instanceCollected turns true on collection without waiting for a notification', async () => {
		const seen: FlowEdge[] = [];
		registerHook('create', ({ edge }) => {
			seen.push(edge);
		});
		createAndDrop('Gone');
		const edge = seen.find((item) => item.name === 'Gone');
		expect(edge!.instanceCollected).toBe(false);
		const collected = await awaitCollected(edge!);
		expect(collected).toBe(true);
		expect(edge!.kind).toBe('create');
		expect(edge!.status).toBe('ok');
	});

	it('copies share the WeakRef: a copy reports collection too', async () => {
		const copy = createCopyAndDrop('CopyShared');
		expect(copy.instanceCollected).toBe(false);
		const collected = await awaitCollected(copy);
		expect(collected).toBe(true);
		expect(copy.kind).toBe('create');
	});
});

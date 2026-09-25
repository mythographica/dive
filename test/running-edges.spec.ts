/**
 * The running-edges store (design note: reports/running-edges-store-design.md).
 *
 * The semantics under test:
 *
 *   - every edge is born 'running' and lands in the store at recordEdge
 *   - settle removes it: sync return, promise resolve, promise reject,
 *     error mark — the four transition sites
 *   - the store is an index of status === 'running', queryable via
 *     getRunningEdges(), and dive's ONLY strong root over edges: a running
 *     edge is never collectable
 *   - clear() empties it
 *
 * Lookup note: wrapped-call edges are named by CALLSITE, not by the wrap
 * label (the label lives on the wrapper), so these tests find edges by
 * context identity — copies share the instance getter with the live edge.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
	wrap,
	recordCreation,
	getRunningEdges,
	getFlow,
	clear,
} from '../src/index.js';
import type { FlowEdge } from '../src/index.js';

function byContext (list: FlowEdge[], ctx: object): FlowEdge | undefined {
	const result = list.find(edge => edge.instance === ctx);
	return result;
}

describe('running edges store', () => {

	beforeEach(() => {
		clear();
	});

	it('a sync wrapped call settles immediately and is not running', () => {
		const ctx = { id : 'sync' };
		const fn = wrap(() => 42, ctx);
		fn();
		// sanity: the edge exists in the flow (lookup is not vacuous)
		expect(byContext(getFlow(ctx), ctx)).toBeDefined();
		expect(byContext(getRunningEdges(), ctx)).toBeUndefined();
	});

	it('an async wrapped call is running while pending, gone after resolve', async () => {
		const ctx = { id : 'async' };
		let resolveIt: (value: number) => void = () => undefined;
		const gate = new Promise<number>((resolve) => {
			resolveIt = resolve;
		});
		const fn = wrap(() => gate, ctx);
		fn();
		const pendingEdge = byContext(getRunningEdges(), ctx);
		expect(pendingEdge).toBeDefined();
		expect(pendingEdge!.status).toBe('running');
		resolveIt(7);
		await gate;
		// the tap's continuation runs as a microtask after gate resolves
		await Promise.resolve();
		expect(byContext(getRunningEdges(), ctx)).toBeUndefined();
	});

	it('a throwing wrapped call leaves the store through the error mark', () => {
		const ctx = { id : 'thrower' };
		const fn = wrap(() => {
			throw new Error('boom');
		}, ctx);
		expect(() => fn()).toThrow('boom');
		expect(byContext(getFlow(ctx), ctx)).toBeDefined();
		expect(byContext(getRunningEdges(), ctx)).toBeUndefined();
	});

	it('a rejecting wrapped call leaves the store through the error mark', async () => {
		const ctx = { id : 'rejecter' };
		const fn = wrap(() => Promise.reject(new Error('async boom')), ctx);
		const caught = fn().catch((error: Error) => error);
		await caught;
		await Promise.resolve();
		expect(byContext(getRunningEdges(), ctx)).toBeUndefined();
	});

	it('clear() empties the store', () => {
		const ctx = { id : 'never' };
		const gate = new Promise<void>(() => undefined);
		const fn = wrap(() => gate, ctx);
		fn();
		expect(getRunningEdges().length).toBeGreaterThan(0);
		clear();
		expect(getRunningEdges()).toEqual([]);
	});
});

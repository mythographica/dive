/**
 * Tests for instanceSource provenance (reports/lastcontext-roadmap.md, item c).
 *
 * The semantics under test:
 *
 *   - wrap(fn, ctx) records 'explicit' — the caller named the context
 *   - wrap(fn) over a non-empty ambient records 'ambient' — the fallback is
 *     newest-wins lastContext, flagged so consumers can distrust it
 *   - wrap(fn) with an EMPTY ambient records no instance and no flag:
 *     attribution is true or absent, never guessed
 *   - capture happens at WRAP time, so concurrent flows keep their explicit
 *     stories while an out-of-band construction only stains later
 *     contextless wraps — and those are visibly 'ambient'
 *   - method / create / recontext edges are always 'explicit': their context
 *     is the receiver or an argument, never the ambient
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
	wrap,
	enterContext,
	recordCreation,
	wrapInstanceMethods,
	getFlow,
	registerHook,
	clear,
} from '../src/index.js';
import type { FlowEdge } from '../src/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('instanceSource provenance', () => {
	beforeEach(() => {
		clear();
	});

	it('wrap with an explicit context records explicit attribution', () => {
		const ctx = { id : 'request' };
		const fn = wrap(() => 1, ctx, 'entry');
		fn();

		const edge = getFlow(ctx).find((e) => e.kind === 'call' && e.label === 'entry');
		expect(edge?.instance).toBe(ctx);
		expect(edge?.instanceSource).toBe('explicit');
	});

	it('contextless wrap over a non-empty ambient records ambient attribution', () => {
		const session = { id : 'session' };
		enterContext(session);
		const fn = wrap(() => 1, 'lonely');
		fn();

		const edge = getFlow(session).find((e) => e.kind === 'call' && e.label === 'lonely');
		expect(edge?.instance).toBe(session);
		expect(edge?.instanceSource).toBe('ambient');
	});

	it('contextless wrap over an EMPTY ambient records no instance and no flag', () => {
		// no instance exists to target getFlow at: the enter hook sees the edge
		const seen: FlowEdge[] = [];
		registerHook('enter', ({ edge }) => {
			seen.push(edge);
		});
		const fn = wrap(() => 1, 'bare');
		fn();

		const edge = seen.find((e) => e.kind === 'call' && e.label === 'bare');
		expect(edge?.instance).toBeUndefined();
		expect(edge?.instanceSource).toBeUndefined();
	});

	it('interleaving: concurrent explicit flows stay truthful; out-of-band construction only stains later contextless wraps', async () => {
		const ctxA = { id : 'flow-a' };
		const ctxB = { id : 'flow-b' };

		const flowA = wrap(async () => {
			await sleep(10);
			return 'a';
		}, ctxA, 'flowA');
		const flowB = wrap(async () => {
			await sleep(20);
			return 'b';
		}, ctxB, 'flowB');

		const pendingA = flowA();
		const pendingB = flowB();

		// Out-of-band construction while both flows are in flight (the WS
		// channel / REPL case): moves lastContext without anyone noticing
		const oob = { id : 'out-of-band' };
		recordCreation('OutOfBand', oob);

		// A contextless wrap made NOW captures the stale ambient — flagged
		const stray = wrap(() => 'stray', 'stray');
		stray();

		await Promise.all([pendingA, pendingB]);

		// each edge is reachable from the branch it belongs to: the explicit
		// flows from their contexts; the stray ambient capture and the
		// construction from the out-of-band instance (stray parented on it)
		const edgeA = getFlow(ctxA).find((e) => e.label === 'flowA');
		const edgeB = getFlow(ctxB).find((e) => e.label === 'flowB');
		const oobFlow = getFlow(oob);
		const edgeStray = oobFlow.find((e) => e.label === 'stray');
		const edgeOob = oobFlow.find((e) => e.kind === 'create' && e.name === 'OutOfBand');

		// Explicit flows: own instance, explicit source, rooted on their OWN
		// story (null parent at depth 0 with no prior edge) — the interleaved
		// construction did not merge the branches
		expect(edgeA?.instance).toBe(ctxA);
		expect(edgeA?.instanceSource).toBe('explicit');
		expect(edgeA?.parentId).toBeNull();
		expect(edgeB?.instance).toBe(ctxB);
		expect(edgeB?.instanceSource).toBe('explicit');
		expect(edgeB?.parentId).toBeNull();

		// The ambient capture wears the foreign instance — but SAYS so
		expect(edgeStray?.instance).toBe(oob);
		expect(edgeStray?.instanceSource).toBe('ambient');

		// recordCreation itself is explicit (instance arrives as an argument)
		expect(edgeOob?.instance).toBe(oob);
		expect(edgeOob?.instanceSource).toBe('explicit');

		// Each branch reconstructs to exactly its own story
		const branchA = getFlow(ctxA);
		expect(branchA.map((e) => e.label)).toEqual(['flowA']);
		const branchB = getFlow(ctxB);
		expect(branchB.map((e) => e.label)).toEqual(['flowB']);
	});

	it('method edges are explicit: the receiver is the context', () => {
		class Service {
			greet () {
				return 'hi';
			}
		}
		const svc = new Service();
		wrapInstanceMethods(svc);
		svc.greet();

		const edge = getFlow(svc).find((e) => e.kind === 'method' && e.name === 'greet');
		expect(edge?.instance).toBe(svc);
		expect(edge?.instanceSource).toBe('explicit');
	});

	it('recontext handoff edges are explicit: the context arrives as an argument', () => {
		const request = { id : 'request' };
		const service = { id : 'service' };
		const w1 = wrap(() => 1, request);
		const w2 = wrap(w1, service);
		expect(w2).not.toBe(w1);

		const edge = getFlow(service).find((e) => e.kind === 'recontext');
		expect(edge?.instance).toBe(service);
		expect(edge?.instanceSource).toBe('explicit');
	});
});

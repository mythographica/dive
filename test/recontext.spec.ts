/**
 * Tests for re-wrap shadowing and the 'recontext' handoff edge.
 *
 * The semantics under test (see DECISIONS.md):
 *
 *   - wrap of a wrapper with no/same context is idempotent (returned as-is)
 *   - wrap of a wrapper with a DIFFERENT context shadows: a fresh wrapper
 *     around the ORIGINAL fn, bound to the new context, and a 'recontext'
 *     handoff edge parenting the old story onto the new one
 *   - the OLD wrapper keeps telling the OLD story (scope shadowing affects
 *     the returned reference, not existing ones)
 *   - auto-wrap crossings (function args) never shadow: a callback keeps
 *     its story when passed through another flow
 *   - constructor-arg holders have no origin info and never shadow
 *   - an instance's evicted latest edge parents nothing: forgotten
 *     continuation points become fresh roots (no dangling parentId)
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
	wrap,
	wrapConstructorArg,
	getFlow,
	isWrappedFunction,
	setTraceLimit,
	clear,
} from '../src/index.js';

describe('re-wrap policy', () => {
	beforeEach(() => {
		clear();
		setTraceLimit(1024);
	});

	it('wrap of a wrapper with no context is idempotent', () => {
		const ctx = { id: 'a' };
		const fn = () => 1;
		const w1 = wrap(fn, ctx);
		const w2 = wrap(w1);
		expect(w2).toBe(w1);
	});

	it('wrap of a wrapper with the SAME context is idempotent', () => {
		const ctx = { id: 'a' };
		const fn = () => 1;
		const w1 = wrap(fn, ctx);
		const w2 = wrap(w1, ctx);
		expect(w2).toBe(w1);
	});

	it('wrap of a wrapper with a DIFFERENT context shadows: new wrapper, original fn', () => {
		const request = { id: 'request' };
		const service = { id: 'service' };
		const fn = () => 1;
		const w1 = wrap(fn, request);
		const w2 = wrap(w1, service);

		expect(w2).not.toBe(w1);
		expect(isWrappedFunction(w2)).toBe(true);
		// the shadow fired the handoff: a recontext edge on the new context
		const serviceFlow = getFlow(service);
		expect(serviceFlow.length).toBe(1);
		expect(serviceFlow[0].kind).toBe('recontext');
		expect(serviceFlow[0].instance).toBe(service);
		// the old context has no edges yet — nothing to parent on
		expect(serviceFlow[0].parentId).toBeNull();
	});

	it('the handoff edge parents on the OLD context latest edge, so getFlow crosses the re-root', () => {
		const request = { id: 'request' };
		const service = { id: 'service' };
		const fn = () => 1;

		const w1 = wrap(fn, request);
		w1(); // request story: call edge
		const requestFlow = getFlow(request);
		expect(requestFlow.length).toBe(1);

		const w2 = wrap(w1, service); // handoff: request → service
		w2(); // service story continues from the handoff

		const serviceFlow = getFlow(service);
		expect(serviceFlow.length).toBe(3);
		// oldest first: request's call, the handoff, service's call
		expect(serviceFlow[0].kind).toBe('call');
		expect(serviceFlow[0].instance).toBe(request);
		expect(serviceFlow[1].kind).toBe('recontext');
		expect(serviceFlow[1].instance).toBe(service);
		expect(serviceFlow[1].parentId).toBe(serviceFlow[0].id);
		expect(serviceFlow[2].kind).toBe('call');
		expect(serviceFlow[2].instance).toBe(service);
		expect(serviceFlow[2].parentId).toBe(serviceFlow[1].id);
	});

	it('the OLD wrapper keeps telling the OLD story after shadowing', () => {
		const request = { id: 'request' };
		const service = { id: 'service' };
		const fn = () => 1;

		const w1 = wrap(fn, request);
		const w2 = wrap(w1, service);

		w1(); // must still record under request, untouched by the shadow
		const requestFlow = getFlow(request);
		expect(requestFlow.length).toBe(1);
		expect(requestFlow[0].kind).toBe('call');
		expect(requestFlow[0].instance).toBe(request);
		expect(requestFlow[0].parentId).toBeNull();
	});

	it('auto-wrap crossings never shadow: args keep their story through another flow', () => {
		const request = { id: 'request' };
		const service = { id: 'service' };
		const fn = () => 1;

		const w1 = wrap(fn, request);
		// the service flow receives the already-wrapped callback as an arg
		const serviceRunner = wrap((cb: () => number) => cb(), service);
		serviceRunner(w1);

		// no handoff was recorded: the service branch is a single call edge
		const serviceFlow = getFlow(service);
		expect(serviceFlow.length).toBe(1);
		expect(serviceFlow[0].kind).toBe('call');
		expect(serviceFlow.every((edge) => edge.kind !== 'recontext')).toBe(true);

		// and the callback's own invocation stayed on the request story:
		// its edge carries the request instance. It IS parented on the
		// serviceRunner edge — depth > 0, "Y called X" is the truth —
		// but no recontext edge exists and the context never switched.
		const requestFlow = getFlow(request);
		expect(requestFlow.length).toBe(2);
		expect(requestFlow[0].instance).toBe(service);
		expect(requestFlow[1].instance).toBe(request);
		expect(requestFlow[1].parentId).toBe(requestFlow[0].id);
	});

	it('constructor-arg holders cannot be shadowed (no origin info by design)', () => {
		const parent = { id: 'parent' };
		const other = { id: 'other' };
		const fn = () => 1;
		const held = wrapConstructorArg(fn, parent);
		const rewrapped = wrap(held, other);
		expect(rewrapped).toBe(held);
		expect(getFlow(other).length).toBe(0);
	});
});

describe('trace honesty: evicted continuation points', () => {
	beforeEach(() => {
		clear();
		setTraceLimit(1024);
	});

	it('an instance whose latest edge was evicted starts a fresh root instead of a dangling parent', () => {
		const ctxA = { id: 'a' };
		const ctxB = { id: 'b' };
		const fnA = () => 'a';
		const fnB = () => 'b';

		setTraceLimit(3);

		const wA = wrap(fnA, ctxA);
		const wB = wrap(fnB, ctxB);

		wA(); // e1 — ctxA's only edge
		wB(); // e2
		wB(); // e3
		wB(); // e4 — buffer {e2, e3, e4}, e1 evicted; ctxA's latestEdge is stale

		wA(); // e5 — must NOT claim the evicted e1 as parent

		const flowA = getFlow(ctxA);
		expect(flowA.length).toBe(1);
		expect(flowA[0].parentId).toBeNull();
	});
});

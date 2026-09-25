/**
 * REAL failure path end to end — the object-linked thesis on a timer that
 * fires long after its request returned.
 *
 * A sync helper builds the ctx chain, schedules a WRAPPED setTimeout that
 * throws, and returns holding NOTHING. An unrelated request is recorded
 * right after, so the newest-wins switcher (lastContext) roots THAT chain —
 * our chain's only possible root is the wrapped timer closure. Forced GC
 * runs while the timer is pending: in wrapped mode the chain must survive
 * (stats.collectedEdges unchanged); in unwrapped mode it must collect.
 * Then, in a real uncaughtException handler, the Error must still yield
 * the request's creation branch and the originating data — and the
 * unrelated request's branch must NOT contaminate it.
 *
 * Sensitivity to the pin path was proven once by a real break-revert of
 * dive src (pinError skipped at the wrapped-call throw site) — the spec
 * went red, the break was reverted. Log:
 * /code/experiments/2026-09-25-dive-timer-uncaught/
 *
 * NOTE: the child imports the compiled build/ (no TS loader available), so
 * `npm run build` must be current for this test to reflect src changes.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(here, 'fixtures', 'timer-uncaught-child.mjs');

interface ChildReport {
	via           : string;
	chainSurvived : boolean;
	diveInHandler : string | null;
	flowKinds     : string[];
	flowStatus    : string[];
}

function runChild (mode: 'wrapped' | 'unwrapped') {
	const out = execFileSync(process.execPath, ['--expose-gc', childScript, mode], {
		encoding : 'utf8',
	});
	return JSON.parse(out) as ChildReport;
}

describe('REAL failure path: wrapped timer long after the request returned', () => {
	it('wrapped: GC cannot collect the pending chain; uncaughtException reads the request story from the Error; unrelated request does not contaminate', () => {
		const r = runChild('wrapped');
		expect(r.via).toBe('uncaughtException');
		// the object-linked guarantee, measured: the wrapped closure roots the
		// chain through the whole GC phase
		expect(r.chainSurvived).toBe(true);
		// the data: the pinned instance is the order (the deepest construction)
		expect(r.diveInHandler).toBe('order-1');
		// the flow: oldest first, the request's own branch only — no
		// create:UnrelatedRequest / create:UnrelatedOrder from step 2
		expect(r.flowKinds).toEqual(['create:Request', 'create:Order', 'call:late']);
		expect(r.flowStatus).toEqual(['ok', 'ok', 'error']);
	});

	it('unwrapped negative control: the chain collects under GC; no pin, empty flow, no data', () => {
		const r = runChild('unwrapped');
		expect(r.via).toBe('uncaughtException');
		// the exact contrast: with nothing wrapping the callback, nothing
		// roots the request's chain — GC collects it while the timer is
		// pending. (The unrelated chain survives via lastContext — that is
		// the documented newest-wins residue, and this test does not lean
		// on it either way.)
		expect(r.chainSurvived).toBe(false);
		expect(r.diveInHandler).toBeNull();
		expect(r.flowKinds).toEqual([]);
		expect(r.flowStatus).toEqual([]);
	});
});

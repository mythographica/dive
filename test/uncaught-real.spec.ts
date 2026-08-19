/**
 * REAL crash-boundary test — the Goal, end to end.
 *
 * uncaughtException and unhandledRejection never know where they came from
 * or which data caused them. This test crosses both boundaries in a child
 * process with a decoupled consumer (the case ALS genuinely cannot handle)
 * and compares dive against ALS head-to-head.
 *
 * Expected (encoded from observation):
 *   - ALS  -> getStore() is null in the handler (ambient store is gone).
 *   - dive -> getErrorInstance(err) recovers the ORIGIN INSTANCE, and
 *             getFlow(err) recovers the branch: create:Entity -> method.
 *
 * NOTE: the child imports the compiled build/ (no TS loader available), so
 * `npm run build` must be current for this test to reflect src changes.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(here, 'fixtures', 'uncaught-child.mjs');

function runChild (mode: 'throw' | 'reject') {
	const out = execFileSync(process.execPath, [childScript, mode], { encoding: 'utf8' });
	return JSON.parse(out) as {
		via           : string;
		alsInHandler  : string | null;
		diveInHandler : string | null;
		flowKinds     : string[];
		flowStatus    : string[];
	};
}

describe('REAL crash boundary: dive vs ALS (decoupled consumer)', () => {
	it('uncaughtException: dive recovers the data AND the flow; ALS store is gone', () => {
		const r = runChild('throw');
		expect(r.via).toBe('uncaughtException');
		expect(r.alsInHandler).toBeNull(); // ALS: ambient store gone
		expect(r.diveInHandler).toBe('origin-instance'); // dive: data on the error
		expect(r.flowKinds).toEqual(['create:Entity', 'method:process']);
		expect(r.flowStatus).toEqual(['running', 'error']);
	});

	it('unhandledRejection: dive recovers the data AND the flow; ALS store is gone', () => {
		const r = runChild('reject');
		expect(r.via).toBe('unhandledRejection');
		expect(r.alsInHandler).toBeNull();
		expect(r.diveInHandler).toBe('origin-instance');
		expect(r.flowKinds).toEqual(['create:Entity', 'method:processAsync']);
		expect(r.flowStatus).toEqual(['running', 'error']);
	});
});

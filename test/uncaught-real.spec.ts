/**
 * REAL crash-boundary test (replaces the simulated stress-test claim).
 *
 * The existing stress test runs with noThrow=true and never actually crosses
 * an uncaughtException / unhandledRejection boundary. This test does, in a
 * child process, and compares dive against ALS head-to-head.
 *
 * Result (observed, then encoded):
 *   - Decoupled consumer fails outside the request's async subtree.
 *   - ALS  -> getStore() is null in the handler (ambient store is gone).
 *   - dive -> getErrorInstance(err) recovers the origin (pinned to the error).
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
	};
}

describe('REAL crash boundary: dive vs ALS (decoupled consumer)', () => {
	it('uncaughtException: dive recovers origin from the error; ALS store is gone', () => {
		const r = runChild('throw');
		expect(r.via).toBe('uncaughtException');
		expect(r.diveInHandler).toBe('origin-instance'); // dive: pinned to error object
		expect(r.alsInHandler).toBeNull();               // ALS: ambient store gone
	});

	it('unhandledRejection: dive recovers origin from the error; ALS store is gone', () => {
		const r = runChild('reject');
		expect(r.via).toBe('unhandledRejection');
		expect(r.diveInHandler).toBe('origin-instance');
		expect(r.alsInHandler).toBeNull();
	});
});

/**
 * Object links (AGENTS.md "settled facts"): whoever needs a flow holds the
 * EDGE OBJECT, never its id, so the GC decides retention.
 *
 * An Error pins its failing edge object; the same contract over GC proves
 * the pinned branch survives collection cycles for as long as the Error
 * itself is held.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
	wrap,
	getFlow,
	getErrorInstance,
	recordCreation,
	clear,
} from '../src/index.js';

const gcOf = globalThis as typeof globalThis & { gc?: () => void };

function forceGc (): void {
	if (typeof gcOf.gc !== 'function') {
		throw new Error('requires node --expose-gc (NODE_OPTIONS=--expose-gc)');
	}
	gcOf.gc();
}

// see weak-instance-refs.spec.ts: the test frame must not hold the
// instance — create, wrap and throw inside a sync helper frame so only the
// returned Error keeps the data alive
function failAndReturnError (): Error {
	const ctx = { request : 1 };
	let caught: Error | undefined;
	try {
		wrap(function failing () {
			throw new Error('boom');
		}, ctx)();
	} catch (error) {
		caught = error as Error;
	}
	const result = caught!;
	return result;
}

describe('step 3 — an Error holds its edge object', () => {

	beforeEach(() => {
		clear();
	});

	it('getFlow(error) keeps the failing edge through forced GC', async () => {
		const caught = failAndReturnError();
		// an unrelated newer edge on other data, then collection cycles —
		// nothing needs the failing branch except the Error itself
		recordCreation('After', { after : true });
		forceGc();
		forceGc();
		forceGc();
		// FinalizationRegistry callbacks lag a GC by one task
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		const flow = getFlow(caught);
		expect(flow.length).toBeGreaterThan(0);
		const failing = flow[flow.length - 1];
		expect(failing.kind).toBe('call');
		expect(failing.status).toBe('error');
		expect(getErrorInstance(caught)).toEqual({ request : 1 });
	});
});

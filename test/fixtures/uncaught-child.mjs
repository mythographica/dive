/**
 * Child process for the REAL crash-boundary experiment.
 *
 * Faithfully models the dive thesis: a DECOUPLED queue consumer.
 *   - A "request" runs inside als.run(), creates an instance, enqueues it,
 *     and RETURNS. No async work is left running inside the als.run subtree.
 *   - A SEPARATE consumer flow (NOT a descendant of als.run) drains the queue
 *     later and fails.
 *   - A process-level handler tries to recover the originating context.
 *
 * This is the case ALS genuinely cannot handle: the consumer's async resource
 * was never inside als.run(), so the ambient store is gone. (Contrast: if the
 * failure happens inside the request's own async subtree, modern Node DOES
 * propagate ALS into the handler — so that scenario proves nothing.)
 *
 * We compare two recovery channels in the SAME handler:
 *   - ALS:  als.getStore()        — ambient, tied to the async resource
 *   - dive: getErrorInstance(err) — pinned to the error object itself
 *
 * Run: node uncaught-child.mjs throw | reject
 * Prints a single JSON line, then exits 0.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { enrichError, getErrorInstance } from '../../build/index.js';

const mode = process.argv[2] || 'throw';
const als = new AsyncLocalStorage();
const queue = [];

function report (via, err) {
	const store = als.getStore();
	const inst = getErrorInstance(err);
	process.stdout.write(JSON.stringify({
		via,
		alsInHandler  : store ? store.id : null,
		diveInHandler : inst ? inst.id : null,
	}));
	process.exit(0);
}

process.on('uncaughtException', (err) => report('uncaughtException', err));
process.on('unhandledRejection', (reason) => report('unhandledRejection', reason));

// The "request": establishes ALS context, creates + enqueues an instance,
// then RETURNS. Its synchronous scope (and async subtree) is fully done.
als.run({ id: 'req-Z-ambient', requestId: 'req-Z' }, () => {
	const instance = { id: 'origin-instance', requestId: 'req-Z' };
	queue.push(instance);
});

// DECOUPLED consumer: a separate top-level async flow, NOT inside any als.run().
// This is the queue drained "30s later" in the dive README.
setTimeout(() => {
	const instance = queue.shift();
	const err = new Error('boom from queue');
	enrichError(err, instance); // dive: pin the instance to the error
	if (mode === 'throw') {
		throw err; // -> uncaughtException
	} else {
		Promise.reject(err); // -> unhandledRejection
	}
}, 5);

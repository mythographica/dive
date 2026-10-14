/**
 * Child process: a request builds a chain and hands back a WRAPPED
 * callback; main arms it as a timer that fires long after the request
 * returned, throws, and a REAL uncaughtException handler reads the
 * request's story from the Error.
 *
 * The object-linked thesis, on the failure path end to end:
 *   1. handleRequest() builds the ctx chain with recordCreation only (no
 *      mnemonica needed) and hands back the late callback — the wrapped
 *      closure is the chain's only root (held by main's frame until the
 *      timer is armed, exactly as the timer queue would hold it).
 *   2. An UNRELATED request is recorded right away, so the newest-wins
 *      switcher (lastContext) roots ITS chain — never ours. Our chain's
 *      only possible root is the wrapped timer closure.
 *   3. The GC phase runs (+ a macrotask so the FinalizationRegistry
 *      counters flush) and the survival measurement is SEALED; only then
 *      is the timer armed — a timer firing mid-measurement would report
 *      before chainSurvived is computed. In wrapped mode the chain must
 *      survive (stats.collectedEdges unchanged); in unwrapped mode it
 *      must collect (the exact contrast).
 *   4. The timer fires -> throw -> uncaughtException -> the handler reports
 *      getFlow(err) / getErrorInstance(err) as JSON.
 *
 * Run: node --expose-gc timer-uncaught-child.mjs wrapped|unwrapped
 * Prints a single JSON line, then exits 0.
 */
import {
	wrap,
	recordCreation,
	getErrorInstance,
	getFlow,
	stats,
} from '../../build/index.js';

const mode = process.argv[2] || 'wrapped';

// GC-phase result, filled before the crash; the crash report folds it in.
const gcResult = { chainSurvived: false };

const sleepTick = () => new Promise((resolve) => {
	setTimeout(resolve, 0);
});

function handleRequest () {
	const req = { id: 'req-1' };
	const order = { id: 'order-1' };
	recordCreation('Request', req);
	recordCreation('Order', order, req);
	const late = mode === 'wrapped'
		? wrap(function late () { throw new Error('late'); }, order)
		: function late () { throw new Error('late'); };
	// returns the callback but schedules nothing — main arms the timer
	return late;
}

function unrelatedRequest () {
	const req = { id: 'req-2' };
	const order = { id: 'order-2' };
	recordCreation('UnrelatedRequest', req);
	recordCreation('UnrelatedOrder', order, req);
}

function report (via, err) {
	const inst = getErrorInstance(err);
	const flow = getFlow(err);
	process.stdout.write(JSON.stringify({
		via,
		chainSurvived : gcResult.chainSurvived,
		diveInHandler : inst ? inst.id : null,
		flowKinds     : flow.map((edge) => `${edge.kind}:${edge.name}`),
		flowStatus    : flow.map((edge) => edge.status),
	}));
	process.exit(0);
}

process.on('uncaughtException', (err) => report('uncaughtException', err));

async function main () {
	const late = handleRequest();
	unrelatedRequest(); // BEFORE the GC rounds: lastContext must root THIS
	// chain, not ours — see the header. Our chain's only root is the wrap.
	const collectedAfterRequest = stats.collectedEdges;
	for (let i = 0; i < 3; i++) {
		globalThis.gc();
		await sleepTick();
	}
	globalThis.gc();
	const collectedAfterGc = stats.collectedEdges;
	gcResult.chainSurvived = collectedAfterGc === collectedAfterRequest;
	// arm the timer only after the measurement is sealed
	setTimeout(late, 0);
	await new Promise((resolve) => {
		setTimeout(resolve, 500);
	});
	// the timer always throws — reaching here means the test is broken
	process.stdout.write(JSON.stringify({ via: 'NO_CRASH' }));
	process.exit(1);
}

main();

/**
 * Child process for the REAL crash-boundary experiment.
 *
 * Faithfully models the dive thesis: a DECOUPLED queue consumer.
 *   - A "request" runs inside als.run(), creates a mnemonica instance,
 *     enqueues it, and RETURNS. No async work is left running inside the
 *     als.run subtree.
 *   - A SEPARATE consumer flow (NOT a descendant of als.run) drains the queue
 *     later and FAILS while processing the instance.
 *   - A process-level handler tries to recover the originating context.
 *
 * This is the case ALS genuinely cannot handle: the consumer's async resource
 * was never inside als.run(), so the ambient store is gone. (Contrast: if the
 * failure happens inside the request's own async subtree, modern Node DOES
 * propagate ALS into the handler — so that scenario proves nothing.)
 *
 * We compare two recovery channels in the SAME handler:
 *   - ALS:  als.getStore()        — ambient, tied to the async resource
 *   - dive: getErrorInstance(err) — the data pinned to the error at the
 *     failure site, plus getFlow(err) — the execution branch that produced it
 *
 * Run: node uncaught-child.mjs throw | reject
 * Prints a single JSON line, then exits 0.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTypesCollection } from 'mnemonica/module';
import {
	enterContext,
	wrapConstructorArg,
	upgradeConstructorArg,
	wrapInstanceMethods,
	recordCreation,
	recordCreationError,
	isWrappedFunction,
	getErrorInstance,
	getFlow,
} from '../../build/index.js';

const mode = process.argv[2] || 'throw';
const als = new AsyncLocalStorage();
const queue = [];

// The wiring that used to ship inside dive as attachHooks() — mnemonica-specific,
// now adapter-level (@mnemonica/nestjs). Inlined here because this fixture runs
// as a plain node child process and cannot import the TS test helper.
function attachHooks (collection) {
	collection.registerHook('preCreation', ({ existentInstance: parent, args }) => {
		if (parent) {
			enterContext(parent);
		}
		if (Array.isArray(args)) {
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (typeof arg === 'function' && !isWrappedFunction(arg)) {
					args[i] = wrapConstructorArg(arg, parent);
				}
			}
		}
	});

	collection.registerHook('postCreation', (hookData) => {
		const instance = hookData.inheritedInstance;
		if (!instance) {
			return;
		}
		if (Array.isArray(hookData.args)) {
			for (const arg of hookData.args) {
				upgradeConstructorArg(arg, instance);
			}
		}
		recordCreation(hookData.TypeName || 'anonymous', instance, hookData.existentInstance);
		wrapInstanceMethods(instance);
	});

	collection.registerHook('creationError', (hookData) => {
		recordCreationError(
			hookData.TypeName || 'anonymous',
			hookData.inheritedInstance,
			hookData.existentInstance
		);
	});
}

function report (via, err) {
	const store = als.getStore();
	const inst = getErrorInstance(err);
	const flow = getFlow(err);
	process.stdout.write(JSON.stringify({
		via,
		alsInHandler  : store ? store.id : null,
		diveInHandler : inst ? inst.id : null,
		flowKinds     : flow.map((edge) => `${edge.kind}:${edge.name}`),
		flowStatus    : flow.map((edge) => edge.status),
	}));
	process.exit(0);
}

process.on('uncaughtException', (err) => report('uncaughtException', err));
process.on('unhandledRejection', (reason) => report('unhandledRejection', reason));

// A mnemonica type with methods that FAIL — dive's attachHooks wraps them,
// so the failure is pinned to the instance with its trace.
const collection = createTypesCollection();
attachHooks(collection);

const Entity = collection.define('Entity', function (data) {
	this.id = data.id;
	this.requestId = data.requestId;
	const proto = Object.getPrototypeOf(this);
	proto.process = function () {
		throw new Error('boom from queue');
	};
	proto.processAsync = async function () {
		throw new Error('async boom from queue');
	};
});

// The "request": establishes ALS context, creates + enqueues an instance,
// then RETURNS. Its synchronous scope (and async subtree) is fully done.
als.run({ id: 'req-Z-ambient', requestId: 'req-Z' }, () => {
	const instance = new Entity({ id: 'origin-instance', requestId: 'req-Z' });
	queue.push(instance);
});

// DECOUPLED consumer: a separate top-level async flow, NOT inside any als.run().
// This is the queue drained "30s later" in the dive README.
setTimeout(() => {
	const instance = queue.shift();
	if (mode === 'throw') {
		instance.process(); // throws -> uncaughtException
	} else {
		instance.processAsync(); // rejects -> unhandledRejection
	}
}, 5);

/**
 * Random queue consumer for the dive stress test.
 *
 * Picks instances from the global registry and randomly:
 *   - processes them successfully
 *   - throws sync errors
 *   - rejects async
 *   - attempts nested construction
 */
import { enrichError } from '../../src/index.js';
import { pickRandom, registrySize } from './registry.js';
import { pushToDlq } from './dlq.js';

function randomId () : string {
	return Math.random().toString(36).slice(2, 10);
}

/**
 * Start the random consumer. Returns a promise that resolves
 * when the registry is empty or the timeout is reached.
 */
export function startConsumer (options?: {
	timeoutMs?  : number;
	successRate?: number;
	noThrow?    : boolean;
}) : Promise<void> {
	const timeoutMs = options?.timeoutMs ?? 30000;
	const successRate = options?.successRate ?? 0.55;
	const noThrow = options?.noThrow ?? false;
	const startTime = Date.now();

	return new Promise((resolve) => {
		function tick () {
			if (registrySize() === 0 || Date.now() - startTime > timeoutMs) {
				resolve();
				return;
			}

			const instance = pickRandom();
			if (!instance) {
				resolve();
				return;
			}

			// Schedule next tick FIRST so queue continues even if we throw.
			const delay = 20 + Math.floor(Math.random() * 80);
			setTimeout(tick, delay);

			const inst = instance as Record<string, unknown>;
			const uuid = String(inst.uuid || randomId());
			const requestId = String(inst.requestId || 'unknown');
			const dice = Math.random();

			if (dice < successRate) {
				// success
			} else if (dice < 0.72) {
				const err = new Error(`sync throw: ${uuid}`);
				enrichError(err, instance);
				pushToDlq({ requestId, uuid, instance, errorType: 'sync-throw' });
				if (!noThrow) throw err;
			} else if (dice < 0.86) {
				const err = new Error(`async rejection: ${uuid}`);
				enrichError(err, instance);
				pushToDlq({ requestId, uuid, instance, errorType: 'unhandled-rejection' });
				if (!noThrow) {
					setImmediate(() => {
						Promise.reject(err);
					});
				}
			} else {
				const childCtor = inst.StressChild;
				if (typeof childCtor === 'function') {
					try {
						new (childCtor as new (data: unknown) => object)({ forceError: true });
					} catch (err) {
						enrichError(err as Error, instance);
						pushToDlq({ requestId, uuid, instance, errorType: 'creation-error' });
						if (!noThrow) throw err;
					}
				} else {
					const err = new Error(`no child ctor: ${uuid}`);
					enrichError(err, instance);
					pushToDlq({ requestId, uuid, instance, errorType: 'sync-throw' });
					if (!noThrow) throw err;
				}
			}
		}

		setTimeout(tick, 50);
	});
}

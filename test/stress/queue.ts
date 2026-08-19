/**
 * Random queue consumer for the dive stress test.
 *
 * Picks instances from the global registry and randomly:
 *   - processes them successfully
 *   - throws sync errors
 *   - rejects async
 *   - attempts nested construction
 *
 * Failures are produced INSIDE wrapped boundaries — that is the dive way:
 * the consumer wraps its processing with the instance it picked, so the
 * failure is pinned to the data that caused it, with its flow trace.
 */
import { wrap } from '../../src/index.js';
import { pickRandom, registrySize } from './registry.js';
import { pushToDlq } from './dlq.js';

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
			const uuid = String(inst.uuid || 'unknown');
			const dice = Math.random();

			if (dice < successRate) {
				// success
			} else if (dice < 0.72) {
				const err = new Error(`sync throw: ${uuid}`);
				try {
					// processing happens inside the instance's own boundary
					wrap(() => {
						throw err;
					}, instance)();
				} catch (caught) {
					pushToDlq({ error: caught as Error, errorType: 'sync-throw' });
				}
				if (!noThrow) throw err;
			} else if (dice < 0.86) {
				const err = new Error(`async rejection: ${uuid}`);
				// a wrapped rejection is pinned to the instance when it settles
				const pending = wrap(() => Promise.reject(err), instance)() as Promise<unknown>;
				pending.catch((caught: Error) => {
					pushToDlq({ error: caught, errorType: 'unhandled-rejection' });
				});
				if (!noThrow) {
					setImmediate(() => {
						Promise.reject(err); // real boundary: already pinned above
					});
				}
			} else {
				const childCtor = inst.StressChild;
				if (typeof childCtor === 'function') {
					try {
						// creationError hook pins the failure to the surviving parent
						new (childCtor as new (data: unknown) => object)({ forceError: true });
					} catch (caught) {
						pushToDlq({ error: caught as Error, errorType: 'creation-error' });
						if (!noThrow) throw caught;
					}
				} else {
					const err = new Error(`no child ctor: ${uuid}`);
					try {
						wrap(() => {
							throw err;
						}, instance)();
					} catch (caught) {
						pushToDlq({ error: caught as Error, errorType: 'sync-throw' });
					}
					if (!noThrow) throw err;
				}
			}
		}

		setTimeout(tick, 50);
	});
}

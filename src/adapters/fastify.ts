/**
 * Fastify adapter for @mnemonica/dive.
 *
 * NOT exported from the main dive module.
 * Import directly if you need Fastify integration.
 */
import { getLastContext, enrichError } from '../index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createDivePlugin (fastify: any) : Promise<void> {
	fastify.addHook('onError', async (_request: any, _reply: any, error: Error) => {
		const diveCtx = getLastContext();
		if (diveCtx) {
			enrichError(error, diveCtx);
		}
	});
}

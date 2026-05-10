/**
 * NestJS adapter for @mnemonica/dive.
 *
 * NOT exported from the main dive module.
 * Import directly if you need NestJS integration.
 */
import { getLastContext, enrichError } from '../index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDiveInterceptor () : any {
	return {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		intercept (_ctx: any, next: any) {
			return next.handle();
		},
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDiveExceptionFilter () : any {
	return {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		catch (exception: Error, _host: any) {
			const diveCtx = getLastContext();
			if (diveCtx) {
				enrichError(exception, diveCtx);
			}
			throw exception;
		},
	};
}

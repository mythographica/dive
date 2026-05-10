/**
 * NestJS adapter for @mnemonica/dive.
 *
 * NOT exported from the main dive module.
 * Import directly if you need NestJS integration.
 */
import { getLastContext, enrichError } from '../index.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDiveInterceptor() {
    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        intercept(_ctx, next) {
            return next.handle();
        },
    };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDiveExceptionFilter() {
    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        catch(exception, _host) {
            const diveCtx = getLastContext();
            if (diveCtx) {
                enrichError(exception, diveCtx);
            }
            throw exception;
        },
    };
}
//# sourceMappingURL=nestjs.js.map
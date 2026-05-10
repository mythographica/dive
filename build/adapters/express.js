/**
 * Express adapter for @mnemonica/dive.
 *
 * NOT exported from the main dive module.
 * Import directly if you need Express integration.
 */
import { getLastContext, enrichError } from '../index.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDiveMiddleware() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_req, _res, next) => {
        const originalNext = next;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        next = function (err) {
            if (err) {
                const diveCtx = getLastContext();
                if (diveCtx) {
                    enrichError(err, diveCtx);
                }
            }
            originalNext(err);
        };
        next();
    };
}
//# sourceMappingURL=express.js.map
/**
 * Mnemonica types for the dive stress test suite.
 *
 * These are defined on defaultTypes so that attachHooks(defaultTypes)
 * auto-wraps instance methods via the postCreation hook.
 */
import { defaultTypes } from 'mnemonica/module';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const StressEntity = defaultTypes.define('StressEntity', function (data) {
    this.uuid = data.uuid;
    this.requestId = data.requestId;
    this.value = data.value;
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const StressChild = StressEntity.define('StressChild', function (data) {
    if (data.forceError) {
        throw new Error('forced child construction error');
    }
    this.childData = data;
});
//# sourceMappingURL=types.js.map
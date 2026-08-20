/**
 * Mnemonica types for the dive stress test suite.
 *
 * These are defined on defaultTypes so that attachHooks(defaultTypes)
 * auto-wraps instance methods via the postCreation hook.
 */
import { defaultTypes } from 'mnemonica/module';
import { attachHooks } from '../helpers/attach-hooks.js';

export interface StressData {
	uuid      : string;
	requestId : string;
	value     : unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const StressEntity: any = defaultTypes.define('StressEntity', function (
	this : StressData,
	data : StressData
) {
	this.uuid = data.uuid;
	this.requestId = data.requestId;
	this.value = data.value;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const StressChild: any = StressEntity.define('StressChild', function (
	this : { childData: unknown },
	data : { forceError?: boolean }
) {
	if (data.forceError) {
		throw new Error('forced child construction error');
	}
	this.childData = data;
});

// Dive lifecycle wiring for the stress types — attached ONCE at module load.
// clear() between tests resets the trace; hook registrations stay.
attachHooks(defaultTypes);

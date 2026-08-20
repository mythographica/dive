/**
 * Test-local re-implementation of the wiring that used to ship inside dive as
 * attachHooks(). That wiring is mnemonica-specific, so it moved to the adapter
 * level (@mnemonica/nestjs). Keeping an equivalent here proves the primitives
 * dive exports are sufficient to rebuild it — and keeps the suite exercising
 * the same lifecycle behavior as before the move.
 */
import {
	enterContext,
	wrapConstructorArg,
	upgradeConstructorArg,
	wrapInstanceMethods,
	recordCreation,
	recordCreationError,
	isWrappedFunction,
} from '../../src/index.js';

interface HookData {
	inheritedInstance?: object;
	existentInstance?: object;
	args?: unknown[];
	TypeName?: string;
}

interface HookableCollection {
	registerHook (type: string, fn: (hookData: HookData) => void): void;
}

export function attachHooks (collection: HookableCollection): void {
	collection.registerHook('preCreation', (hookData) => {
		const parent = hookData.existentInstance;
		if (parent) {
			enterContext(parent);
		}
		const args = hookData.args;
		if (Array.isArray(args)) {
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (typeof arg === 'function' && !isWrappedFunction(arg)) {
					args[i] = wrapConstructorArg(arg as (...a: unknown[]) => unknown, parent);
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

/**
 * CJS build smoke test — F12: jest ≤29 (CJS runtime) could not load dive at
 * all ("SyntaxError: Unexpected token 'export'"), reached transitively via
 * @mnemonica/nestjs build-cjs. The package now ships build-cjs/ next to
 * build/, and the exports map routes `require` there.
 *
 * This spec require()s the CJS entry the way a CJS test runtime does and
 * asserts the API surface plus one wrap passthrough. It exercises compiled
 * output (build-cjs/), so it depends on pretest running `npm run build` —
 * same rule as uncaught-real.spec.ts and build/.
 *
 * NOTE: the CJS entry is a SECOND module instance, separate from the ESM
 * one other specs import — its trace/hooks state is its own. Assertions
 * here stay on the CJS instance alone.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

type DiveModule = typeof import('../src/index.js');

const cjsRequire = createRequire(import.meta.url);
const cjs : DiveModule = cjsRequire('../build-cjs/index.js');

describe('build-cjs (F12)', () => {

	it('require()s the CJS entry without a syntax error', () => {
		expect(typeof cjs.wrap).toBe('function');
	});

	it('exposes the full public API surface', () => {
		const fns : (keyof DiveModule)[] = [
			'wrap',
			'current',
			'getFlow',
			'getTrace',
			'getRunningEdges',
			'getErrorInstance',
			'setTraceLimit',
			'setWeakInstanceRefs',
			'getCollectedInstanceCount',
			'registerHook',
			'unregisterHook',
			'clear',
			'enterContext',
			'wrapConstructorArg',
			'upgradeConstructorArg',
			'wrapInstanceMethods',
			'recordCreation',
			'recordCreationError',
			'isWrappedFunction',
		];
		for (const name of fns) {
			expect(typeof cjs[name], name).toBe('function');
		}
	});

	it('wrap passthrough works on the CJS instance', () => {
		cjs.clear();
		const before = cjs.getTrace().length;
		const ctx = {};
		const wrapped = cjs.wrap(function probe () {
			const result = 42;
			return result;
		}, ctx);
		const result = wrapped();
		expect(result).toBe(42);
		expect(cjs.getTrace().length).toBe(before + 1);
		cjs.clear();
	});

});

/**
 * Type-level test: wrap() keeps the exact signature of typed-param
 * functions and classes. Runs tsc on test/fixtures/wrap-typed-params.ts —
 * the fixture's @ts-expect-error lines mean a wrong call compiling is ALSO
 * a failure (tsc reports the unused suppression).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('wrap() type level', () => {
	it('typed-param functions and classes keep their exact signatures', () => {
		const tscBin = path.join(here, '..', 'node_modules', 'typescript', 'bin', 'tsc');
		const fixture = path.join(here, 'fixtures', 'wrap-typed-params.ts');
		const run = spawnSync(process.execPath, [
			tscBin,
			'--noEmit',
			'--strict',
			'--skipLibCheck',
			'--module', 'nodenext',
			'--moduleResolution', 'nodenext',
			'--target', 'es2022',
			fixture,
		], { encoding : 'utf8' });
		expect(run.status, run.stdout + run.stderr).toBe(0);
	});
});

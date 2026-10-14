import { defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';

const resolved = path.resolve(__dirname, '../core/module/index.js');

// Local-dev shortcut: when the sibling core checkout exists, tests run
// against it directly. Everywhere else (CI, fresh clones) the alias is
// omitted and vitest resolves mnemonica from node_modules.
const alias = fs.existsSync(resolved)
	? [
		{
			find        : /^mnemonica$/,
			replacement : resolved,
		},
		{
			find        : /^mnemonica\/module$/,
			replacement : resolved,
		},
	]
	: [];

export default defineConfig({
	test : {
		globals     : true,
		environment : 'node',
		include     : ['test/**/*.spec.ts'],
		coverage    : {
			// Measure src/ only. build/ + build-cjs/ carry inline sourcemaps
			// back to src/: the cjs-build spec loads build-cjs in-process,
			// and its payload would remap onto src/index.ts as a second,
			// barely-exercised copy of every function (the col-0 fnMap
			// entries). Filtering at collection (the raw URL) keeps the
			// report honest.
			include : ['src/**'],
		},
	},
	resolve : {
		alias,
	},
});

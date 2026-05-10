import { defineConfig } from 'vitest/config';
import path from 'path';

const resolved = path.resolve(__dirname, '../core/module/index.js');

export default defineConfig({
	test : {
		globals     : true,
		environment : 'node',
		include     : ['test/**/*.spec.ts'],
	},
	resolve : {
		alias : [
			{
				find        : /^mnemonica$/,
				replacement : resolved,
			},
			{
				find        : /^mnemonica\/module$/,
				replacement : resolved,
			},
		],
	},
});

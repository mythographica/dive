// ESLint flat config for @mnemonica/dive — modelled on mnemonica/core's
// eslint.config.js, minus what does not fit: no mocha (tests import from
// 'vitest' explicitly), no build/ block (both build dirs are gitignored).
// The mnemonica/return-intermediate rule is dive's own style law (AGENTS.md
// "Style"); the plugin lives in .eslint-plugins/ as .cjs (verbatim copy of
// core's — this package is type:module, so the plugin needs the .cjs
// extension to stay CommonJS).
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';
import noArrowThis from 'eslint-plugin-no-arrow-this';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import mnemonica from './.eslint-plugins/index.cjs';

const commonRules = {
	'indent': ['error', 'tab'],
	'key-spacing': ['warn', {
		beforeColon: true,
		afterColon: true,
		align: 'colon',
	}],
	'linebreak-style': ['error', 'unix'],
	'quotes': ['error', 'single'],
	'semi': ['error', 'always'],
	'no-unused-vars': 'off',
	'@typescript-eslint/no-unused-vars': 'error',
	'no-shadow': ['error', {
		builtinGlobals: true,
		hoist: 'all',
		allow: ['this'],
	}],
	'array-bracket-spacing': ['error', 'always'],
	'computed-property-spacing': ['error', 'always'],
	'object-curly-spacing': ['error', 'always'],
	'space-before-function-paren': ['error', {
		'anonymous': 'always',
		'named': 'always',
		'asyncArrow': 'always',
	}],
	'prefer-template': 'warn',
	'prefer-spread': 'warn',
	'no-useless-concat': 'warn',
	'prefer-rest-params': 'warn',
	'prefer-destructuring': 'warn',
	'no-useless-computed-key': 'warn',
	'no-useless-constructor': 'warn',
	'no-useless-rename': 'warn',
	'no-this-before-super': 'warn',
	'no-new-symbol': 'warn',
	'no-duplicate-imports': 'warn',
	'no-confusing-arrow': 'warn',
	'no-multi-assign': 'warn',
	'no-lonely-if': 'warn',
	'newline-per-chained-call': 'warn',
	'func-name-matching': 'error',
	'line-comment-position': ['warn', {
		position: 'above',
	}],
	'max-len': ['error', { code: 120, tabWidth: 4, ignoreUrls: true }],
	'object-curly-newline': ['error', {
		ImportDeclaration: { multiline: true, minProperties: 2 },
		ExportDeclaration: { multiline: true, minProperties: 2 },
		ObjectPattern: { multiline: true, minProperties: 3 },
	}],
	'function-paren-newline': ['error', 'multiline'],
	'@typescript-eslint/no-var-requires': 'off',
	'@typescript-eslint/no-empty-function': 'off',
	'@typescript-eslint/no-explicit-any': 'error',
	'@typescript-eslint/no-require-imports': 'off',
	'@typescript-eslint/no-this-alias': 'off',
	'@typescript-eslint/ban-ts-comment': 'warn',
	'new-cap': 'off',
	'yoda': 'warn',
	'mnemonica/return-intermediate': 'error',
	// Bare Function/CallableFunction/NewableFunction are banned as TYPES —
	// a named interface that extends them is the rule
	// (core's .ai/rules-code-style.md "Function Type Rules").
	'no-restricted-syntax': ['error', {
		selector: "TSTypeReference[typeName.type='Identifier'][typeName.name=/^(Function|CallableFunction|NewableFunction)$/]",
		message: 'Use a named interface that extends Function/CallableFunction/NewableFunction (see core .ai/rules-code-style.md "Function Type Rules")',
	}],
};

const commonLanguageOptions = {
	parser: tsParser,
	globals: {
		...globals.node,
	},
	ecmaVersion: 'latest',
	sourceType: 'module',
};

const commonPlugins = {
	'no-arrow-this': noArrowThis,
	'@typescript-eslint': typescriptEslint,
	'mnemonica': mnemonica,
};

export default [
	// Config for src directory
	{
		files: ['src/**/*.ts'],
		languageOptions: commonLanguageOptions,
		plugins: commonPlugins,
		rules: commonRules,
	},
	// Config for test directory (spec files; fixtures are plain node
	// child-process scripts, ignored below)
	{
		files: ['test/**/*.ts'],
		languageOptions: commonLanguageOptions,
		plugins: commonPlugins,
		rules: {
			...commonRules,
			'max-len': 'off',
			'object-curly-newline': 'off',
			'function-paren-newline': 'off',
		},
	},
	// Global ignores
	{
		ignores: [
			'build/**',
			'build-cjs/**',
			'coverage/**',
			'node_modules/**',
			'test/fixtures/**',
			'eslint.config.js',
		],
	},
];

/**
 * Child for the CJS callsite test (callsite.spec.ts) — the build-cjs/ twin
 * of callsite-mapped-child.mjs.
 *
 * The callsite filter must skip dive's own frames by DIRECTORY and land on
 * this file, both plain (frames are build-cjs/*.js) and under node
 * --enable-source-maps (frames resolve to dive's src/*.ts via the inline
 * map).
 *
 * Run: node callsite-cjs-child.cjs
 *      node --enable-source-maps callsite-cjs-child.cjs
 * Prints a single JSON line: { "name": "<edge caption>" }.
 */
const { wrap, registerHook } = require('../../build-cjs/index.js');

// Inline anonymous arrow: no fn.name, no label — the caption IS the callsite.
// The enter hook hands over the edge for reading.
let name = '';
registerHook('enter', ({ edge }) => {
	name = edge.name;
});
wrap(() => 1)();

process.stdout.write(JSON.stringify({ name }));

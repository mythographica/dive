/**
 * Child for the source-mapped callsite test (callsite.spec.ts).
 *
 * With node --enable-source-maps, the stack frames of dive's internals
 * resolve to dive's src/*.ts (the build carries inlineSourceMap). The
 * callsite filter must STILL skip them and land on this file — before the
 * fix, an exact self-path match missed the mapped frames and the caption
 * became dive's own src/index.ts:434:16.
 *
 * Run: node --enable-source-maps callsite-mapped-child.mjs
 * Prints a single JSON line: { "name": "<edge caption>" }.
 */
import { wrap, getTrace } from '../../build/index.js';

// Inline anonymous arrow: no fn.name, no label — the caption IS the callsite.
wrap(() => 1)();

const trace = getTrace();
process.stdout.write(JSON.stringify({ name: trace[0].name }));

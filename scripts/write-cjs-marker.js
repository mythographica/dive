#!/usr/bin/env node
/**
 * Marks build-cjs/ as CommonJS. The package root says "type": "module",
 * so without this marker Node would parse the CJS-compiled files as ESM
 * and fail on `require`. The marker ships inside build-cjs/ (see files).
 *
 * Run by `npm run build`, after `tsc -p tsconfig.cjs.json`.
 */
import { writeFileSync } from 'node:fs';

const marker = JSON.stringify({ type: 'commonjs' }) + '\n';
writeFileSync('build-cjs/package.json', marker);

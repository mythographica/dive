/**
 * Bulb identity: caption cascade + callsite capture at wrap time.
 *
 *   label + named fn     → `label:name`  (one label groups many names)
 *   label + anonymous fn → callsite      (the label survives on edge.label)
 *   no label             → fn.name → callsite → 'anonymous'
 *
 * The callsite is captured ONCE per wrap (never per invocation), normalised
 * to plain file:line:col — the same format tactica writes into eds.json —
 * and preserved across re-roots: a bulb's identity is where it was FIRST
 * wrapped, not where it was re-rooted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	wrap,
	clear,
	registerHook,
} from '../src/index.js';
import type { FlowEdge } from '../src/index.js';

const SymbolDiveCallsite = Symbol.for('mnemonica.dive.callsite');

// There is no whole-trace dump API: these tests collect edges through the
// enter hook — live edges, record order.
function collectEdges (): FlowEdge[] {
	const seen: FlowEdge[] = [];
	registerHook('enter', ({ edge }) => {
		seen.push(edge);
	});
	return seen;
}

describe('bulb identity: caption cascade', () => {
	beforeEach(() => {
		clear();
	});

	it('names the edge after the function when no label is given', () => {
		function namedWork () {
			return 1;
		}
		const wrapped = wrap(namedWork);
		const seen = collectEdges();
		wrapped();
		expect(seen[0].name).toBe('namedWork');
		expect(seen[0].label).toBeUndefined();
	});

	it('prefixes the name with the label when both are given', () => {
		function namedWork () {
			return 1;
		}
		const wrapped = wrap(namedWork, 'guard');
		const seen = collectEdges();
		wrapped();
		expect(seen[0].name).toBe('guard:namedWork');
		expect(seen[0].label).toBe('guard');
	});

	it('accepts a label after an explicit context', () => {
		function namedWork () {
			return 1;
		}
		const context = {};
		const wrapped = wrap(namedWork, context, 'guard');
		const seen = collectEdges();
		wrapped();
		expect(seen[0].name).toBe('guard:namedWork');
		expect(seen[0].label).toBe('guard');
	});

	it('falls back to the callsite for an anonymous function with a label', () => {
		const wrapped = wrap(function () {
			return 1;
		}, 'guard');
		const seen = collectEdges();
		wrapped();
		expect(seen[0].name).toMatch(/callsite\.spec\.ts:\d+:\d+$/);
		expect(seen[0].label).toBe('guard');
		expect(seen[0].callsite).toBe(seen[0].name);
	});

	it('falls back to the callsite for an anonymous function without a label', () => {
		const wrapped = wrap(() => 1);
		const seen = collectEdges();
		wrapped();
		expect(seen[0].name).toMatch(/callsite\.spec\.ts:\d+:\d+$/);
		expect(seen[0].label).toBeUndefined();
	});
});

describe('bulb identity: callsite capture', () => {
	beforeEach(() => {
		clear();
	});

	it('captures the userland wrap site, never dive internals', () => {
		function namedWork () {
			return 1;
		}
		const wrapped = wrap(namedWork);
		const seen = collectEdges();
		wrapped();
		expect(seen[0].callsite).toMatch(/callsite\.spec\.ts:\d+:\d+$/);
		expect(seen[0].callsite).not.toContain('dive/src');
		expect(seen[0].callsite).not.toContain('dive/build');
	});

	it('gives auto-wrapped returned functions a callsite identity', () => {
		const seen = collectEdges();
		const factory = wrap(function factory () {
			return () => 42;
		});
		const produced = factory();
		produced();
		const producedEdge = seen[seen.length - 1];
		expect(producedEdge.callsite).toMatch(/callsite\.spec\.ts:\d+:\d+$/);
		// the returned arrow is anonymous: its caption IS the callsite
		expect(producedEdge.name).toBe(producedEdge.callsite);
	});

	it('preserves the original callsite across a re-root', () => {
		function namedWork () {
			return 1;
		}
		const ctxA = {};
		const ctxB = {};
		const wrapped = wrap(namedWork, ctxA);
		const rerooted = wrap(wrapped, ctxB);
		const first = (wrapped as unknown as Record<symbol, unknown>)[SymbolDiveCallsite];
		const second = (rerooted as unknown as Record<symbol, unknown>)[SymbolDiveCallsite];
		expect(second).toBe(first);
	});
});

describe('callsite under --enable-source-maps (child process on build/)', () => {
	// NOTE: the child imports the compiled build/, so `npm run build` must be
	// current for this test to reflect src changes (pretest runs tsc).
	it('skips dive-internal frames that resolve to src/*.ts via the inline map', () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const childScript = path.join(here, 'fixtures', 'callsite-mapped-child.mjs');
		const out = execFileSync(
			process.execPath,
			['--enable-source-maps', childScript],
			{ encoding : 'utf8' },
		);
		const { name } = JSON.parse(out) as { name : string };
		// the caption must be the CHILD's callsite, not dive's own source
		expect(name).toMatch(/callsite-mapped-child\.mjs:\d+:\d+$/);
		expect(name).not.toContain('dive/src');
		expect(name).not.toContain('dive/build');
	});
});

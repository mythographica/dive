/**
 * Wrap-site identity: capture the first USERLAND stack frame at wrap time
 * (once per wrap, never per invocation) and compute the bulb caption.
 */
import { ANONYMOUS } from './constants.js';
import type { AnyFn } from './types.js';

// V8 stack frame tail: "    at fn (file:line:col)" or "    at file:line:col"
export const CALLSITE_FRAME = /\(?((?:file:\/\/)?[^()\s]+):(\d+):(\d+)\)?\s*$/;

/**
 * This module's own file as a plain path — the anchor for skipping
 * dive-internal frames when capturing a wrap callsite. The package
 * dual-builds (ESM + CJS) and import.meta.url does not exist under
 * CommonJS, so the path comes from this module's own stack frame instead:
 * the first frame of an Error created here IS this file (ESM: "at
 * file:///…/build/callsite.js:…", CJS: "at Object.<anonymous>
 * (/…/build-cjs/callsite.js:…)").
 */
function computeSelfPath (): string {
	const stack = new Error().stack ?? '';
	const lines = stack.split('\n');
	for (const line of lines) {
		const match = line.match(CALLSITE_FRAME);
		if (match) {
			const matchedPath = match[ 1 ].replace(/^file:\/\//, '');
			return matchedPath;
		}
	}
	// No parseable frame: degrade to "skip nothing" rather than break wrap().
	const selfPath = '';
	return selfPath;
}
const SELF_PATH = computeSelfPath();

// Dive is split across several modules, but they always share ONE directory
// per flavor (build/, build-cjs/, or src/ under vitest) — so dive-internal
// frames are skipped by DIRECTORY, not by single file path. Frames may also
// arrive SOURCE-MAPPED (node --enable-source-maps): they then point at dive's
// own src/*.ts, not the shipped build output, so the src/ twin of the running
// build directory is skipped too (NOT the whole package root: in-repo test
// fixtures live under it, consumers never do).
const SELF_DIR = SELF_PATH.slice(0, SELF_PATH.lastIndexOf('/') + 1);
const SELF_SRC_DIR = SELF_DIR.replace(/\/build(-cjs)?\/$/, '/src/');
const SELF_DIRS = SELF_DIR === '' ? [] : [ SELF_DIR, SELF_SRC_DIR ];

/**
 * Capture the first USERLAND stack frame at wrap time — once per wrap, never
 * per invocation. Normalised to a plain `file:line:col` path, the same format
 * tactica writes into eds.json locations, so a runtime edge joins the AoT
 * probe registry by exact string match.
 */
export function captureCallsite (): string | undefined {
	const probe = new Error();
	const { stack } = probe;
	if (!stack) {
		return undefined;
	}
	const frames = stack.split('\n').slice(1);
	for (const frame of frames) {
		// dive-internal frames all live in one directory per build flavor —
		// a plain substring check skips them without paying for the regex
		// (wrap is setup-time, but wrapArgs makes wrap cost per-call cost in
		// callback-heavy code)
		if (SELF_DIRS.some((dir) => frame.includes(dir))) {
			continue;
		}
		const match = frame.match(CALLSITE_FRAME);
		if (!match) {
			continue;
		}
		const file = match[ 1 ].replace(/^file:\/\//, '');
		if (file.startsWith('node:')) {
			continue;
		}
		const result = `${file}:${match[ 2 ]}:${match[ 3 ]}`;
		return result;
	}
	return undefined;
}

/**
 * Bulb caption cascade:
 *   label + named fn     → `label:name`  (one label groups many names)
 *   label + anonymous fn → callsite      (a bare label cannot tell anonymous
 *                          wraps apart; the label survives on edge.label)
 *   no label             → fn.name, falling back to callsite, then 'anonymous'
 */
export function computeCaption (
	fn: AnyFn,
	label: string | undefined,
	callsite: string | undefined
): string {
	const name = fn.name || undefined;
	if (label !== undefined) {
		if (name) {
			const labelled = `${label}:${name}`;
			return labelled;
		}
		const bare = callsite || ANONYMOUS;
		return bare;
	}
	const result = name || callsite || ANONYMOUS;
	return result;
}

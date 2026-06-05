/**
 * Lifecycle wiring: preCreation + creationError.
 *
 * attachHooks historically wired ONLY postCreation (the built instance becomes
 * the context). These tests pin the rest of the construction lifecycle dive is
 * meant to track:
 *
 *   preCreation   → enter the parent (existentInstance) context BEFORE the
 *                   constructor runs (no built instance exists yet), and wrap
 *                   the incoming function args so callbacks handed to the
 *                   constructor carry that parent context forward.
 *   postCreation  → enter the built instance (covered in dive.spec.ts).
 *   creationError → a failed construction enters the errored instance and pins
 *                   the surviving parent onto the error, so a decoupled consumer
 *                   can recover the origin off the error object itself.
 *
 * Default mnemonica config: the error the caller catches IS the hook's
 * inheritedInstance (identity holds), and for a NESTED construction the hook's
 * existentInstance is the real surviving parent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTypesCollection } from 'mnemonica/module';

import {
	getLastContext,
	attachHooks,
	getErrorInstance,
	clear,
} from '../src/index.js';

describe('attachHooks: preCreation enters parent context', () => {
	beforeEach(() => clear());

	it('the constructor body sees the parent (existentInstance) as context', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const Parent = collection.define('Parent', function (this: { kind: string }) {
			this.kind = 'parent';
		});
		const parent = new Parent();

		let seenDuringCtor: unknown;
		Parent.define('Child', function (this: { kind: string }) {
			seenDuringCtor = getLastContext(); // set by preCreation, before postCreation
			this.kind = 'child';
		});

		clear();
		const child = new parent.Child();

		expect(seenDuringCtor).toBe(parent); // preCreation entered the parent
		expect(getLastContext()).toBe(child); // postCreation then entered the child
	});

	it('wraps function args so a constructor callback carries the parent context', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const Parent = collection.define('Parent', function (this: { kind: string }) {
			this.kind = 'parent';
		});
		const parent = new Parent();

		let received: (() => unknown) | undefined;
		Parent.define('Child', function (this: { kind: string }, cb: () => unknown) {
			received = cb; // the arg AS the constructor receives it
			this.kind = 'child';
		});

		clear();
		const original = () => getLastContext();
		new parent.Child(original);

		expect(received).toBeTypeOf('function');
		expect(received).not.toBe(original); // dive-wrapped, not the raw function

		clear(); // even with ambient context wiped…
		expect(received!()).toBe(parent); // …the closure restores the captured parent
	});
});

describe('attachHooks: creationError pins the surviving parent', () => {
	beforeEach(() => clear());

	it('a failed nested construction leaves the parent recoverable off the error', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const Parent = collection.define('Parent', function (this: { kind: string }) {
			this.kind = 'parent';
		});
		const parent = new Parent();

		Parent.define('Child', function () {
			throw new Error('child boom');
		});

		clear();
		let caught: unknown;
		try {
			new parent.Child();
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(Error);
		// the surviving "before" instance is pinned to the error the caller caught
		expect(getErrorInstance(caught as Error)).toBe(parent);
	});

	it('enters the errored instance as the current context', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const Parent = collection.define('Parent', function (this: { kind: string }) {
			this.kind = 'parent';
		});
		const parent = new Parent();

		Parent.define('Child', function () {
			throw new Error('child boom');
		});

		clear();
		let caught: unknown;
		try {
			new parent.Child();
		} catch (e) {
			caught = e;
		}

		// the last thing that happened is the error: it becomes the current context
		expect(getLastContext()).toBe(caught);
	});
});

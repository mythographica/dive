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
	attachHooks,
	current,
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
			seenDuringCtor = current(); // set by preCreation, before postCreation
			this.kind = 'child';
		});

		clear();
		const child = new parent.Child();

		expect(seenDuringCtor).toBe(parent); // preCreation entered the parent
		expect(current()).toBe(child); // postCreation then entered the child
	});

	it('wraps a function arg, and an UNUSED callback upgrades to the built instance', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const Parent = collection.define('Parent', function (this: { kind: string }) {
			this.kind = 'parent';
		});
		const parent = new Parent();

		let received: (() => unknown) | undefined;
		Parent.define('Child', function (this: { kind: string }, cb: () => unknown) {
			received = cb; // STORED, not invoked during construction
			this.kind = 'child';
		});

		clear();
		const original = () => current();
		const child = new parent.Child(original);

		expect(received).toBeTypeOf('function');
		expect(received).not.toBe(original); // dive-wrapped, not the raw function

		clear(); // even with ambient context wiped…
		// …the callback now resolves to the INSTANCE it belongs to: preCreation
		// captured the parent, postCreation upgraded it because it was never used.
		expect(received!()).toBe(child);
	});

	it('a callback USED during construction stays pinned to the parent', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const Parent = collection.define('Parent', function (this: { kind: string }) {
			this.kind = 'parent';
		});
		const parent = new Parent();

		let stored: (() => unknown) | undefined;
		let duringCtor: unknown;
		Parent.define('Child', function (this: { kind: string }, cb: () => unknown) {
			duringCtor = cb(); // INVOKED during construction — locks to parent
			stored = cb;
			this.kind = 'child';
		});

		clear();
		new parent.Child(() => current());

		expect(duringCtor).toBe(parent); // during construction, context is the parent

		clear();
		// it was used, so postCreation does NOT upgrade it — later calls stay parent
		expect(stored!()).toBe(parent);
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
		expect(current()).toBe(caught);
	});
});

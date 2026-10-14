/**
 * Tests that lastContext IS the instance itself.
 *
 * Verifies that current() returns the mnemonica instance,
 * and that getProps() works on it to access construction history.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTypesCollection, getProps } from 'mnemonica/module';
import { current, clear } from '../src/index.js';
import { attachHooks } from './helpers/attach-hooks.js';

interface ContextSnapshot {
	hasType      : boolean;
	typeName     : string | undefined;
	hasParent    : boolean;
	hasArgs      : boolean;
	hasTimestamp : boolean;
}

interface UserCtxShape {
	name  : string;
	email : string;
	role  : string | undefined;
}

interface FullContextSnapshot {
	name         : string | undefined;
	email        : string | undefined;
	role         : string | undefined;
	typeName     : string | undefined;
	parentName   : string | undefined;
	args         : unknown;
	hasTimestamp : boolean;
}

// One guard for the whole file: the value current() returns has the
// userland shape (or is absent) — narrow once, then plain access
const isUserCtx = function (value: unknown): value is UserCtxShape {
	const matches = typeof value === 'object' && value !== null && 'name' in value && 'email' in value;
	return matches;
};

describe('lastContext IS the instance', () => {
	beforeEach(() => clear());

	it('current() returns the instance itself, not a copy', () => {
		const collection = createTypesCollection();
		attachHooks(collection);

		const MyType = collection.define('TypeCtx', function (this: { id: string; value: number }) {
			this.id = 'test';
			this.value = 42;
		});

		const instance = new MyType();

		// lastContext should be the instance
		const ctx = current();
		expect(ctx).toBe(instance);

		// ctx IS instance (asserted above) — read through the typed
		// reference, no cast
		expect(instance.id).toBe('test');
		expect(instance.value).toBe(42);
	});

	it('getProps works on the context returned by current()', () => {
		const collection = createTypesCollection();

		// Define type with method BEFORE attaching hooks
		const Parent = collection.define('ParentCtx', function (this: {
			kind: string;
			readContext: () => ContextSnapshot | null;
		}) {
			this.kind = 'parent';

			// Add method to prototype before attachHooks
			Object.getPrototypeOf(this).readContext = function () {
				const ctx = current();
				if (ctx) {
					const props = getProps(ctx);
					const snapshot: ContextSnapshot = {
						hasType      : !!props?.__type__,
						typeName     : props?.__type__?.TypeName,
						hasParent    : !!props?.__parent__,
						hasArgs      : !!props?.__args__,
						hasTimestamp : !!props?.__timestamp__,
					};
					return snapshot;
				}
				return null;
			};
		});

		// Now attach hooks - this will wrap the prototype method
		attachHooks(collection);

		const parent = new Parent();
		clear();

		const result = parent.readContext();

		expect(result).not.toBeNull();
		if (result === null) { return; }
		expect(result.hasType).toBe(true);
		expect(result.typeName).toBe('ParentCtx');
		expect(result.hasArgs).toBe(true);
		expect(result.hasTimestamp).toBe(true);
	});

	it('context during method call has correct construction history', () => {
		const collection = createTypesCollection();

		const UserType = collection.define('UserCtx', function (this: {
			name: string;
			email: string;
			readFullContext: () => FullContextSnapshot | null;
		}, data: { name: string; email: string }) {
			this.name = data.name;
			this.email = data.email;

			// Add method to prototype
			Object.getPrototypeOf(this).readFullContext = function () {
				const currentCtx = current();
				if (!isUserCtx(currentCtx)) { return null; }

				const props = getProps(currentCtx);
				const snapshot: FullContextSnapshot = {
					// Instance properties
					name  : currentCtx.name,
					email : currentCtx.email,
					role  : currentCtx.role,

					// Construction history
					typeName     : props?.__type__?.TypeName,
					parentName   : props?.__parent__?.constructor?.name,
					args         : props?.__args__,
					hasTimestamp : !!props?.__timestamp__,
				};
				return snapshot;
			};
		});

		UserType.define('AdminCtx', function (this: { role: string }, role: string) {
			this.role = role;
		});

		// Attach hooks AFTER defining all types
		attachHooks(collection);

		// Create a chain: User -> Admin
		const user = new UserType({ name : 'Alice', email : 'alice@test.com' });
		const admin = new user.AdminCtx('admin');

		clear();

		const result = admin.readFullContext();

		expect(result).not.toBeNull();
		if (result === null) { return; }

		// Instance properties
		expect(result.name).toBe('Alice');
		expect(result.email).toBe('alice@test.com');
		expect(result.role).toBe('admin');

		// Construction history
		expect(result.typeName).toBe('AdminCtx');
		expect(result.parentName).toBe('UserCtx');
		expect(result.hasTimestamp).toBe(true);
	});
});

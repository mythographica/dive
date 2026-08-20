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

		// They should be the same reference
		expect((ctx as any).id).toBe('test');
		expect((ctx as any).value).toBe(42);
	});

	it('getProps works on the context returned by current()', () => {
		const collection = createTypesCollection();

		// Define type with method BEFORE attaching hooks
		const Parent = collection.define('ParentCtx', function (this: {
			kind: string;
			readContext: () => any;
		}) {
			this.kind = 'parent';

			// Add method to prototype before attachHooks
			Object.getPrototypeOf(this).readContext = function () {
				const ctx = current();
				if (ctx) {
					const props = getProps(ctx);
					return {
						hasType     : !!props?.__type__,
						typeName    : props?.__type__?.TypeName,
						hasParent   : !!props?.__parent__,
						hasArgs     : !!props?.__args__,
						hasTimestamp: !!props?.__timestamp__,
					};
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
			readFullContext: () => any;
		}, data: { name: string; email: string }) {
			this.name = data.name;
			this.email = data.email;

			// Add method to prototype
			Object.getPrototypeOf(this).readFullContext = function () {
				const ctx = current() as any;
				if (!ctx) return null;

				const props = getProps(ctx);
				return {
					// Instance properties
					name : ctx.name,
					email: ctx.email,
					role : ctx.role,

					// Construction history
					typeName   : props?.__type__?.TypeName,
					parentName : props?.__parent__?.constructor?.name,
					args       : props?.__args__,
					hasTimestamp: !!props?.__timestamp__,
				};
			};
		});

		const AdminType = UserType.define('AdminCtx', function (this: { role: string }, role: string) {
			this.role = role;
		});

		// Attach hooks AFTER defining all types
		attachHooks(collection);

		// Create a chain: User -> Admin
		const user = new UserType({ name: 'Alice', email: 'alice@test.com' });
		const admin = new user.AdminCtx('admin');

		clear();

		const result = admin.readFullContext();


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

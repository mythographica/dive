/**
 * Tests for @mnemonica/dive — WeakMap-based context propagation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTypesCollection } from 'mnemonica/module';
import type { TypesCollection } from 'mnemonica/module';

import {
	getLastContext,
	setLastContext,
	link,
	wrap,
	wrapArgs,
	wrapInstanceMethods,
	attachHooks,
	enrichError,
	getErrorInstance,
	clear,
	runWithInstance,
} from '../src/index.js';

describe('dive context storage', () => {
	beforeEach(() => {
		clear();
	});

	it('getLastContext returns undefined initially', () => {
		expect(getLastContext()).toBeUndefined();
	});

	it('setLastContext stores the most recent context', () => {
		const obj = { id: 1 };
		setLastContext(obj);
		expect(getLastContext()).toBe(obj);
	});

	it('getLastContext returns the most recently set context', () => {
		const a = { id: 'a' };
		const b = { id: 'b' };
		setLastContext(a);
		setLastContext(b);
		expect(getLastContext()).toBe(b);
	});

	it('clear removes the last context', () => {
		setLastContext({ id: 1 });
		clear();
		expect(getLastContext()).toBeUndefined();
	});
});

describe('dive identifier linking', () => {
	beforeEach(() => {
		clear();
	});

	it('link associates an instance with an identifier', () => {
		const instance = { name: 'test' };
		link(instance, 'my-id');
		expect(getLastContext('my-id')).toBe(instance);
	});

	it('getLastContext returns undefined for unlinked identifier', () => {
		expect(getLastContext('unknown')).toBeUndefined();
	});

	it('link allows multiple identifiers per instance', () => {
		const instance = { name: 'test' };
		link(instance, 'id-a');
		link(instance, 'id-b');
		expect(getLastContext('id-a')).toBe(instance);
		expect(getLastContext('id-b')).toBe(instance);
	});

	it('different instances can have different identifiers', () => {
		const a = { name: 'a' };
		const b = { name: 'b' };
		link(a, 'ida');
		link(b, 'idb');
		expect(getLastContext('ida')).toBe(a);
		expect(getLastContext('idb')).toBe(b);
	});
});

describe('dive wrap', () => {
	beforeEach(() => {
		clear();
	});

	it('wrap restores context when function is called', () => {
		const ctx = { id: 'wrapped' };
		setLastContext(ctx);

		const fn = wrap(() => getLastContext());
		clear();

		expect(fn()).toBe(ctx);
		expect(getLastContext()).toBeUndefined();
	});

	it('wrap restores previous context after invocation', () => {
		const ctxA = { id: 'a' };
		const ctxB = { id: 'b' };
		setLastContext(ctxA);

		const fn = wrap(() => {
			expect(getLastContext()).toBe(ctxB);
			return 'done';
		}, ctxB);

		fn();
		expect(getLastContext()).toBe(ctxA);
	});

	it('wrap preserves function return value', () => {
		const fn = wrap((x: number) => x * 2);
		expect(fn(5)).toBe(10);
	});

	it('wrap preserves this context', () => {
		const obj = {
			value : 42,
			fn    : wrap(function (this: { value: number }) {
				return this.value;
			}),
		};
		expect(obj.fn()).toBe(42);
	});

	it('wrap does not double-wrap functions', () => {
		const fn = () => 'hello';
		const wrapped1 = wrap(fn);
		const wrapped2 = wrap(wrapped1);
		expect(wrapped2).toBe(wrapped1);
	});

	it('wrap supports explicit context argument', () => {
		const ctx = { id: 'explicit' };
		const fn = wrap(() => getLastContext(), ctx);
		expect(fn()).toBe(ctx);
	});
});

describe('dive wrapArgs', () => {
	beforeEach(() => {
		clear();
	});

	it('wrapArgs wraps function arguments', () => {
		const ctx = { id: 'args-test' };
		setLastContext(ctx);

		const args = wrapArgs([
			() => getLastContext(),
			'string',
			123,
		]);

		clear();

		const fn = args[0] as () => object | undefined;
		expect(fn()).toBe(ctx);
		expect(args[1]).toBe('string');
		expect(args[2]).toBe(123);
	});

	it('wrapArgs with explicit context', () => {
		const ctx = { id: 'explicit-args' };
		const args = wrapArgs([() => getLastContext()], ctx);
		const fn = args[0] as () => object | undefined;
		expect(fn()).toBe(ctx);
	});
});

describe('dive wrapInstanceMethods', () => {
	beforeEach(() => {
		clear();
	});

	it('wraps prototype methods to run in instance context', () => {
		class MyClass {
			getContext () {
				return getLastContext();
			}
		}

		const instance = new MyClass();
		wrapInstanceMethods(instance);
		clear();

		expect(instance.getContext()).toBe(instance);
	});

	it('restores previous context after method call', () => {
		const prev = { id: 'prev' };
		setLastContext(prev);

		class MyClass {
			doSomething () {
				return 'done';
			}
		}

		const instance = new MyClass();
		wrapInstanceMethods(instance);
		instance.doSomething();

		expect(getLastContext()).toBe(prev);
	});

	it('wraps callbacks passed to methods', () => {
		class MyClass {
			invokeCallback (cb: () => object | undefined) {
				return cb();
			}
		}

		const instance = new MyClass();
		wrapInstanceMethods(instance);
		clear();

		const result = instance.invokeCallback(() => getLastContext());
		expect(result).toBe(instance);
	});

	it('wraps function return values', () => {
		class MyClass {
			getFn () {
				return () => getLastContext();
			}
		}

		const instance = new MyClass();
		wrapInstanceMethods(instance);
		clear();

		const returnedFn = instance.getFn() as () => object | undefined;
		expect(returnedFn()).toBe(instance);
	});

	it('enriches thrown errors with the instance', () => {
		class MyClass {
			throwError () {
				throw new Error('boom');
			}
		}

		const instance = new MyClass();
		wrapInstanceMethods(instance);

		try {
			instance.throwError();
			expect.fail('should have thrown');
		} catch (error) {
			expect(getErrorInstance(error as Error)).toBe(instance);
		}
	});

	it('enriches promise rejection errors with the instance', async () => {
		class MyClass {
			async reject () {
				throw new Error('async boom');
			}
		}

		const instance = new MyClass();
		wrapInstanceMethods(instance);

		try {
			await instance.reject();
			expect.fail('should have rejected');
		} catch (error) {
			expect(getErrorInstance(error as Error)).toBe(instance);
		}
	});

	it('does not wrap Object.prototype methods', () => {
		const instance = { toString: () => 'custom' };
		wrapInstanceMethods(instance);
		expect(instance.toString()).toBe('custom');
	});
});

describe('dive attachHooks', () => {
	beforeEach(() => {
		clear();
	});

	it('sets last context on instance creation', () => {
		const collection: TypesCollection = createTypesCollection();
		attachHooks(collection);

		const MyType = collection.define('MyType', function () {});
		clear();

		const instance = new MyType();
		expect(getLastContext()).toBe(instance);
	});

	it('wraps instance methods via postCreation hook', () => {
		const collection: TypesCollection = createTypesCollection();
		attachHooks(collection);

		const MyType = collection.define('MyType', function (this: { value: number }) {
			this.value = 42;
		});
		MyType.define('SubType', function (this: { extra: string }) {
			this.extra = 'hello';
		});

		const parent = new MyType();
		clear();

		const child = new parent.SubType();
		expect(getLastContext()).toBe(child);
	});

	it('instance methods run in their own context after hook attach', () => {
		const collection: TypesCollection = createTypesCollection();
		attachHooks(collection);

		const MyType = collection.define('MyType', function () {});
		const instance = new MyType();
		clear();

		// Add a method to the prototype manually for testing
		Object.getPrototypeOf(instance).getContext = function () {
			return getLastContext();
		};

		// Re-wrap since method was added after creation
		wrapInstanceMethods(instance);
		expect(instance.getContext()).toBe(instance);
	});
});

describe('dive error enrichment', () => {
	it('enrichError attaches instance to error', () => {
		const error = new Error('test');
		const instance = { id: 1 };
		enrichError(error, instance);
		expect(getErrorInstance(error)).toBe(instance);
	});

	it('getErrorInstance returns undefined for non-enriched error', () => {
		const error = new Error('plain');
		expect(getErrorInstance(error)).toBeUndefined();
	});

	it('getErrorInstance handles null/undefined', () => {
		expect(getErrorInstance(null as unknown as Error)).toBeUndefined();
		expect(getErrorInstance(undefined as unknown as Error)).toBeUndefined();
	});
});

describe('dive runWithInstance', () => {
	beforeEach(() => {
		clear();
	});

	it('runs function with instance as context', () => {
		const instance = { id: 'run-test' };
		const result = runWithInstance(instance, () => {
			return getLastContext();
		});
		expect(result).toBe(instance);
	});

	it('restores previous context after run', () => {
		const prev = { id: 'prev' };
		setLastContext(prev);

		const instance = { id: 'run-test' };
		runWithInstance(instance, () => {
			expect(getLastContext()).toBe(instance);
		});

		expect(getLastContext()).toBe(prev);
	});

	it('restores context even if function throws', () => {
		const prev = { id: 'prev' };
		setLastContext(prev);

		const instance = { id: 'run-test' };
		try {
			runWithInstance(instance, () => {
				throw new Error('intentional');
			});
		} catch {
			// expected
		}

		expect(getLastContext()).toBe(prev);
	});
});

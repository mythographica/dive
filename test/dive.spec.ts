/**
 * Tests for @mnemonica/dive — context propagation mechanics (public API).
 *
 * The flow trace itself lives in flow.spec.ts. This file pins the retained
 * context mechanics of the simplified API: current(), wrap(), attachHooks()
 * lifecycle, and error enrichment.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTypesCollection } from 'mnemonica/module';
import type { TypesCollection } from 'mnemonica/module';

import {
	wrap,
	current,
	getErrorInstance,
	clear,
} from '../src/index.js';
import { attachHooks } from './helpers/attach-hooks.js';

describe('dive current()', () => {
	beforeEach(() => clear());

	it('returns undefined initially', () => {
		expect(current()).toBeUndefined();
	});

	it('clear removes the current context', () => {
		const ctx = { id: 1 };
		wrap(() => undefined, ctx)();
		clear();
		expect(current()).toBeUndefined();
	});

	it('instance creation enters the instance as current context', () => {
		const collection: TypesCollection = createTypesCollection();
		attachHooks(collection);

		const MyType = collection.define('MyType', function () {});
		clear();

		const instance = new MyType();
		expect(current()).toBe(instance);
	});
});

describe('dive wrap', () => {
	beforeEach(() => clear());

	it('restores the captured context when the function is called', () => {
		const ctx = { id: 'wrapped' };
		const fn = wrap(() => current(), ctx);

		expect(fn()).toBe(ctx);
		expect(current()).toBeUndefined();
	});

	it('captures the ambient context at wrap time when no context is given', () => {
		const ambient = { id: 'ambient' };
		const captured = wrap(() => {
			// inside here, current() is ambient — wrap a closure around it
			return wrap(() => current());
		}, ambient)();

		clear();
		expect(captured()).toBe(ambient);
	});

	it('restores the previous context after invocation', () => {
		const ctxA = { id: 'a' };
		const ctxB = { id: 'b' };

		const fn = wrap(() => {
			expect(current()).toBe(ctxB);
			return 'done';
		}, ctxB);

		wrap(() => {
			fn();
			expect(current()).toBe(ctxA);
		}, ctxA)();
	});

	it('preserves function return value', () => {
		const fn = wrap((x: number) => x * 2);
		expect(fn(5)).toBe(10);
	});

	it('preserves this context', () => {
		const obj = {
			value : 42,
			fn    : wrap(function (this: { value: number }) {
				return this.value;
			}),
		};
		expect(obj.fn()).toBe(42);
	});

	it('does not double-wrap functions', () => {
		const fn = () => 'hello';
		const wrapped1 = wrap(fn);
		const wrapped2 = wrap(wrapped1);
		expect(wrapped2).toBe(wrapped1);
	});

	it('preserves constructor calls with new', () => {
		const ctx = { id: 'ctor' };

		class MyClass {
			value: number;
			contextDuringConstruction: object | undefined;
			constructor () {
				this.value = 42;
				// the constructor body must run with the captured context
				this.contextDuringConstruction = current();
			}
		}

		const WrappedClass = wrap(MyClass as unknown as (...args: unknown[]) => unknown, ctx);
		const instance = new (WrappedClass as unknown as new () => MyClass)();

		expect(instance.value).toBe(42);
		expect(instance).toBeInstanceOf(MyClass);
		expect(instance.contextDuringConstruction).toBe(ctx);
	});

	it('restores context even when constructor throws', () => {
		const ctx = { id: 'prev' };

		class BadClass {
			constructor () {
				throw new Error('intentional');
			}
		}

		const WrappedClass = wrap(BadClass as unknown as (...args: unknown[]) => unknown);
		wrap(() => {
			expect(() => new (WrappedClass as unknown as new () => unknown)()).toThrow('intentional');
			expect(current()).toBe(ctx);
		}, ctx)();
	});

	it('wraps returned functions', () => {
		const ctx = { id: 'return-fn' };

		const fn = wrap(() => {
			return () => current();
		}, ctx);

		clear();
		const returnedFn = fn() as () => object | undefined;
		expect(returnedFn()).toBe(ctx);
	});

	it('wraps nested returned functions', () => {
		const ctx = { id: 'nested' };

		const fn = wrap(() => {
			return () => {
				return () => current();
			};
		}, ctx);

		clear();
		const level1 = fn() as () => unknown;
		const level2 = level1() as () => object | undefined;
		expect(level2()).toBe(ctx);
	});

	it('does not double-wrap returned functions', () => {
		const ctx = { id: 'no-double' };

		const inner = wrap(() => current(), ctx);
		const fn = wrap(() => inner, ctx);

		clear();
		const returned = fn() as () => object | undefined;
		expect(returned()).toBe(ctx);
		expect(returned).toBe(inner);
	});

	it('wraps Promise-resolved functions', async () => {
		const ctx = { id: 'promise-fn' };

		const fn = wrap(() => {
			return Promise.resolve(() => current());
		}, ctx);

		clear();
		const resolvedFn = await fn() as () => object | undefined;
		expect(resolvedFn()).toBe(ctx);
	});

	it('wraps Promise-resolved non-function values unchanged', async () => {
		const fn = wrap(() => Promise.resolve({ value: 123 }));
		const result = await fn();
		expect(result).toEqual({ value: 123 });
	});

	it('does not wrap non-function return values', () => {
		const fn = wrap(() => ({ value: 42 }));
		expect(fn()).toEqual({ value: 42 });
	});

	it('restores context even when function throws', () => {
		const ctx = { id: 'prev' };

		const fn = wrap(() => {
			throw new Error('boom');
		});

		wrap(() => {
			expect(() => fn()).toThrow('boom');
			expect(current()).toBe(ctx);
		}, ctx)();
	});

	it('handles rejected promises without losing context', async () => {
		const ctx = { id: 'prev' };

		const fn = wrap(() => Promise.reject(new Error('async boom')));

		let assertion: Promise<void> | undefined;
		wrap(() => {
			assertion = expect(fn()).rejects.toThrow('async boom');
			// still inside the sync segment: the context holds
			expect(current()).toBe(ctx);
		}, ctx)();
		await assertion;
	});
});

describe('dive wrap: recursive arg propagation', () => {
	beforeEach(() => clear());

	it('wraps the function args passed INTO a wrapped fn (deferred call carries context)', () => {
		const ctx = { id: 'CTX' };
		let stored: (() => unknown) | undefined;
		const f = wrap(function (cb: () => unknown) {
			stored = cb; // store, do not call now
		}, ctx);

		let seen: unknown;
		f(() => { seen = current(); });

		clear(); // ambient context wiped
		stored!(); // call later — only carries ctx if the arg was wrapped
		expect(seen).toBe(ctx);
	});

	it('propagates context recursively into args-of-args', () => {
		const ctx = { id: 'CTX' };
		let level2Ctx: unknown;
		const f = wrap(function (cb: (inner: () => unknown) => void) {
			// cb is a wrapped arg (level 1); hand it a function (level 2 arg-of-arg)
			cb(() => { level2Ctx = current(); });
		}, ctx);

		let stored: (() => unknown) | undefined;
		f((innerArg) => { stored = innerArg; }); // capture the level-2 fn for a later call

		clear();
		stored!(); // invoke the arg-of-arg after context is wiped
		expect(level2Ctx).toBe(ctx); // recursion: the level-2 arg also carries ctx
	});
});

describe('dive generator wrapping', () => {
	beforeEach(() => clear());

	it('manual wrapping for generator body using wrap on each next', () => {
		const ctx = { id: 'gen-manual' };

		function* myGenerator () {
			yield current();
			yield current();
		}

		const gen = myGenerator();

		const step1 = wrap(() => gen.next(), ctx)();
		expect(step1.value).toBe(ctx);
		expect(step1.done).toBe(false);

		const step2 = wrap(() => gen.next(), ctx)();
		expect(step2.value).toBe(ctx);
		expect(step2.done).toBe(false);

		const step3 = wrap(() => gen.next(), ctx)();
		expect(step3.done).toBe(true);
	});
});

describe('dive attachHooks: instance methods', () => {
	let collection: TypesCollection;
	beforeEach(() => {
		clear();
		collection = createTypesCollection();
		attachHooks(collection);
	});

	function defineWithMethods () {
		const MyType = collection.define('Methodful', function (this: {
			value: number;
			getContext: () => object | undefined;
			invokeCallback: (cb: () => unknown) => unknown;
			getFn: () => () => object | undefined;
			getAsyncFn: () => Promise<() => object | undefined>;
			throwError: () => void;
			reject: () => Promise<void>;
		}) {
			this.value = 42;
			const proto = Object.getPrototypeOf(this) as Record<string, unknown>;
			proto.getContext = function (this: object) {
				return current();
			};
			proto.invokeCallback = function (this: object, cb: () => unknown) {
				return cb();
			};
			proto.getFn = function (this: object) {
				return () => current();
			};
			proto.getAsyncFn = async function (this: object) {
				return () => current();
			};
			proto.throwError = function () {
				throw new Error('boom');
			};
			proto.reject = async function () {
				throw new Error('async boom');
			};
		});
		return MyType;
	}

	it('instance methods run in their own context', () => {
		const MyType = defineWithMethods();
		const instance = new MyType();
		clear();

		expect(instance.getContext()).toBe(instance);
	});

	it('restores previous context after method call', () => {
		const MyType = defineWithMethods();
		const prev = { id: 'prev' };

		const instance = new MyType();
		clear();

		wrap(() => {
			instance.getContext();
			expect(current()).toBe(prev);
		}, prev)();
	});

	it('wraps callbacks passed to methods', () => {
		const MyType = defineWithMethods();
		const instance = new MyType();
		clear();

		const result = instance.invokeCallback(() => current());
		expect(result).toBe(instance);
	});

	it('wraps function return values', () => {
		const MyType = defineWithMethods();
		const instance = new MyType();
		clear();

		const returnedFn = instance.getFn();
		expect(returnedFn()).toBe(instance);
	});

	it('wraps Promise-resolved functions from methods', async () => {
		const MyType = defineWithMethods();
		const instance = new MyType();
		clear();

		const resolvedFn = await instance.getAsyncFn();
		expect(resolvedFn()).toBe(instance);
	});

	it('enriches thrown errors with the instance', () => {
		const MyType = defineWithMethods();
		const instance = new MyType();

		try {
			instance.throwError();
			expect.fail('should have thrown');
		} catch (error) {
			expect(getErrorInstance(error as Error)).toBe(instance);
		}
	});

	it('enriches promise rejection errors with the instance', async () => {
		const MyType = defineWithMethods();
		const instance = new MyType();

		try {
			await instance.reject();
			expect.fail('should have rejected');
		} catch (error) {
			expect(getErrorInstance(error as Error)).toBe(instance);
		}
	});

	it('subtype instances get their own method context', () => {
		const MyType = defineWithMethods();
		MyType.define('Sub', function (this: { extra: string }, extra: string) {
			this.extra = extra;
		});

		const parent = new MyType();
		const child = new parent.Sub('hello');
		clear();

		expect(parent.getContext()).toBe(parent);
		expect(child.getContext()).toBe(child);
	});
});

describe('dive error enrichment', () => {
	beforeEach(() => clear());

	it('getErrorInstance returns undefined for a non-enriched error', () => {
		const error = new Error('plain');
		expect(getErrorInstance(error)).toBeUndefined();
	});

	it('getErrorInstance handles null/undefined', () => {
		expect(getErrorInstance(null as unknown as Error)).toBeUndefined();
		expect(getErrorInstance(undefined as unknown as Error)).toBeUndefined();
	});
});

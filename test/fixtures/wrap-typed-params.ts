/**
 * Type-level fixture for wrap(): typed-parameter functions and classes keep
 * their exact signatures through the wrapper. tsc checks this file; the
 * @ts-expect-error lines MUST suppress a real error — if a wrong call ever
 * compiles, tsc reports the unused suppression and the spec goes red.
 *
 * Not imported by any runtime test — test/type-level.spec.ts runs tsc on it.
 */
import { wrap } from '../../src/index.js';

const ctx = { id : 'ctx' };

// typed-param functions wrap and keep their exact signature
const greeter = wrap(function greeter (name: string): number {
	return name.length;
}, ctx);
const len: number = greeter('hello');
void len;

// @ts-expect-error — a wrong arg type must not compile
greeter(42);

const adder = wrap((a: number, b: number): number => a + b);
const sum: number = adder(1, 2);
void sum;

// @ts-expect-error — a string where a number belongs must not compile
adder('1', 2);

// a class constructor comes back AS the class (the class overload)
class Widget {
	size: number;
	constructor (size: number) {
		this.size = size;
	}
}
const WrappedWidget = wrap(Widget, ctx);
const widget = new WrappedWidget(3);
const size: number = widget.size;
void size;

// @ts-expect-error — a wrong ctor arg must not compile
new WrappedWidget('three');

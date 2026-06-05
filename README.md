# @mnemonica/dive

**Execution Data Storage (EDS) — context propagation for mnemonica instances.**

Object-bound context. No AsyncLocalStorage. No `async_hooks`.

Context is pinned to userland objects (instances, error objects, identifiers),
not to async resources. Internally: a module-global "last context" plus an
identifier `Map` — see [Internals](#internals).

Successor to `context-dive` (2018).

---

## The Paradigm Shift

```
ALS:  context is bound to the async resource (timer, I/O, HTTP request)
Dive: context is bound to the mnemonica INSTANCE
```

When data flows through a system, instances carry their own context.
The queue doesn't need to know about the original request — it just
processes instances, and each instance brings its context via `wrap()`.

**Execution flow = Data flow.**

### ALS Problem

```javascript
const als = new AsyncLocalStorage();

als.run({ requestId: 'A' }, () => {
  setTimeout(() => {
    als.getStore(); // { requestId: 'A' } — works
  }, 100);
});
```

ALS works for simple cases. But:

```javascript
// Request creates 100 instances, shuffles them, queues for later
const instances = create100Instances(req);
shuffle(instances);
queue.push(...instances); // ALS context dies with request

// 30 seconds later, queue consumer processes instance #73
// ALS: getStore() === undefined ❌
// Dive: getLastContext() === instance #73 ✅
```

ALS stores one context per async resource. All timers, promises, and I/O
in the same request share the same store. When the request ends, the store
goes away. A queue consumer running 30 seconds later has **no context**.

### Dive Solution

```javascript
import { attachHooks, getLastContext, wrap } from '@mnemonica/dive';
import { defaultTypes } from 'mnemonica';

attachHooks(defaultTypes); // auto-wraps all instance methods

const instance = new MyType({ requestId: 'A', data: 42 });
// postCreation hook fires:
//   - setLastContext(instance)
//   - wrapInstanceMethods(instance)

// Now any callback passed through instance methods
// carries instance as active context:
instance.process((result) => {
  getLastContext() === instance; // true ✅
});
```

Dive captures context at **wrap-time** and restores it at **invocation-time**.
No async resource tracking needed. The instance **is** the context.

---

## Installation

```bash
npm install @mnemonica/dive mnemonica
```

`mnemonica` is a peer dependency.

---

## Quick Start

```typescript
import { attachHooks, getLastContext, wrap, enrichError } from '@mnemonica/dive';
import { defaultTypes } from 'mnemonica';

// One-line activation
attachHooks(defaultTypes);

// Now all instance methods run in their instance's context
const RequestData = defaultTypes.define('RequestData', function (this: { id: string }, data: { id: string }) {
  this.id = data.id;
});

const instance = new RequestData({ id: 'req-123' });
getLastContext() === instance; // true
```

---

## API

### `getLastContext()` / `getLastContext(identifier)`

```typescript
getLastContext(): object | undefined;
getLastContext(identifier: unknown): object | undefined;
```

Returns the most recently active instance, or the instance linked to an identifier.

### `link(instance, identifier)`

```typescript
link(instance: object, identifier: unknown): void;
```

Link an instance to an identifier for later retrieval.

### `unlink(identifier)`

```typescript
unlink(identifier: unknown): void;
```

Remove an identifier link. Call this when the identifier is done (e.g. on
request completion) to avoid leaking entries in the strong identifier `Map`.

### `attachHooks(collection)`

```typescript
attachHooks(collection: { registerHook(type: string, fn: Function): void }): void;
```

Wire into mnemonica's `postCreation` hook. Auto-wraps instance methods.

### `wrap(fn, context?)`

```typescript
wrap<T extends (...args: unknown[]) => unknown>(fn: T, context?: object): T;
```

Capture current context and restore it when `fn` is called.

### `wrapArgs(args, context?)`

```typescript
wrapArgs(args: unknown[], context?: object): unknown[];
```

Auto-wrap function arguments in an array.

### `enrichError(error, instance)`

```typescript
enrichError(error: Error, instance: object): void;
```

Attach an instance to an error for later retrieval.

### `getErrorInstance(error)`

```typescript
getErrorInstance(error: Error): object | undefined;
```

Retrieve the instance attached to an error.

### `runWithInstance(instance, fn)`

```typescript
runWithInstance<T>(instance: object, fn: () => T): T;
```

Execute a function with a specific instance as active context.

### `clear()`

Reset for testing.

---

## Stress Test

A stress scenario proves context survival across random async boundaries. It
is a test fixture (`test/stress/`), not a published entry point — run it with
`npm test` or read it as a worked example.

```typescript
// test/stress/runner.ts
const result = await runStressTest(100, 0.7, 30000);
// result.report.total     → number of failures
// result.report.byType    → { 'sync-throw': 10, 'unhandled-rejection': 2, ... }
// result.report.byRequest → { 'req-id': 12 }
```

Flow:
1. Create 100 `StressEntity` instances with random values
2. Fisher-Yates shuffle, register 70% to global registry
3. Random consumer picks instances (80-250ms intervals)
4. ~55% success | ~17% sync throw | ~14% async reject | ~14% nested construction
5. All failures enriched with dive context
6. DLQ collects failures, produces report at 12 items

**Key result:** every failure is traceable back to the originating request,
even though instances were shuffled, queued, and processed minutes later.

---

## Framework Integration

There are no framework-specific adapters. Activation is one line — call
`attachHooks(defaultTypes)` once at startup, and every mnemonica instance
created while serving a request becomes context automatically (the instance
**is** the context). To recover context at a request boundary by a bare
identifier (e.g. a request id), `link()` the instance to that identifier and
read it back with `getLastContext(identifier)`.

---

## ALS Comparison

| Scenario | ALS | Dive |
|----------|-----|------|
| Simple async chain | ✅ Works | ✅ Works |
| Synchronous instance creation | ❌ Loses context | ✅ Shifts per instance |
| setTimeout 30s later | ❌ Store gone | ✅ Context preserved |
| Random queue shuffle | ❌ No traceability | ✅ Every failure linked |
| Nested construction error | ❌ No parent context | ✅ Parent in error |
| Memory overhead | One store per async resource | One entry per wrapped fn |

---

## Intentionally Not Covered

Dive wraps **direct function calls, constructors, Promise chains, and instance methods**. It does NOT auto-wrap every possible execution boundary. Here is why.

### What We Do NOT Track

| Boundary | Status | Reason |
|----------|--------|--------|
| Arrays / objects containing functions | **Use `wrap()`** | Deep inspection causes false positives (every object method would be wrapped) |
| `setTimeout` / `setInterval` | **Use `wrap()`** | Timer monkey-patching breaks user code and third-party libraries |
| Event emitters (`on`, `once`) | **Use `wrap()`** | Would need to patch Node.js EventEmitter prototype — fragile |
| Streams (`pipe`, `on('data')`) | **Use `wrap()`** | Same as emitters; also streams often live longer than context |
| Property getters / setters | **Not supported** | `wrapInstanceMethods` only handles `descriptor.value`, not accessors |
| Generators / `yield` | **Use `wrap()`** | Each `yield` creates a suspension point; auto-wrapping requires intercepting `next()` |

### Why Not Auto-Wrap Everything?

Auto-wrapping every boundary causes a **cyclomatic / combinatory explosion**:

```
Function return → wrap?
  ├─ function → YES
  ├─ Promise → unwrap .then() → check resolved value
  │   ├─ function → YES
  │   ├─ Promise → recurse
  │   ├─ Array → iterate → check each element
  │   │   ├─ function → YES
  │   │   ├─ object → inspect keys → ...
  │   └─ object → inspect keys → ...
  ├─ Array → iterate → check each element → ...
  └─ object → inspect keys → ...
```

This is not just performance overhead — it is **correctness overhead**. Deep auto-wrapping:
- Wraps user-intentional plain objects (false positives)
- Breaks library code that expects unwrapped references
- Creates memory leaks if we hold strong refs to every returned object

### Manual Wrapping Is the Escape Hatch

For any boundary not auto-wrapped, use `wrap()` explicitly:

```typescript
// Arrays containing callbacks
const handlers = [fn1, fn2, fn3];
const wrappedHandlers = handlers.map(fn => wrap(fn, instance));

// setTimeout
setTimeout(wrap(() => processTask(), instance), 1000);

// Event emitters
emitter.on('data', wrap(onData, instance));
```

### Generators and `yield`

Generators create a **suspension boundary** at every `yield`. Dive does not auto-wrap them because `yield` can fire across arbitrary async boundaries. Manually wrap the generator function:

```typescript
function* myGenerator() {
  const ctx = getLastContext();
  yield step1(ctx);
  yield step2(ctx);
}

// Wrap the generator instantiation
const wrappedGen = wrap(() => myGenerator(), instance);
const gen = wrappedGen();

// Each .next() runs in the captured context
const result1 = gen.next(); // step1 runs with instance as context
const result2 = gen.next(); // step2 runs with instance as context
```

For async generators, wrap the async generator function the same way — the `async` keyword does not change the wrapping semantics.

### The Rule of Thumb

> If the execution flow **passes through a function call**, Dive can track it.
> If the flow **escapes through a non-function boundary** (array slot, event emitter, stream), use `wrap()` manually.

This keeps Dive predictable, fast, and correct.

---

## History

- **2018:** `context-dive` — `async_hooks` + manual callback patching
- **2020:** `AsyncLocalStorage` — native Node.js, 90% coverage
- **2025:** `@mnemonica/dive` — object-bound context, no ALS

Motivation: [nodejs/diagnostics#249](https://github.com/nodejs/diagnostics/issues/249) —
synchronous execution splits break `async_hooks`-based CLS.

---

## Internals

The store is three parts (no `async_hooks`):

- `lastContext` — a single module-global holding the most recent context. It is
  newest-wins and is clobbered by concurrent flows unless you capture per-flow
  context with `wrap()` / `runWithInstance()`.
- a `WeakMap` for **object identifiers** — `link(instance, requestObject)` keys
  by the object and is collected together with it, so there is no leak and no
  cleanup needed. This is how you pin context to a request boundary: key by the
  request object.
- a strong `Map` for **primitive identifiers** — `link(instance, 'uuid')` keys
  by a primitive, which cannot be a `WeakMap` key. These are held strongly until
  removed with `unlink()`; long-lived processes that `link()` primitives without
  `unlink()` will leak.

Context also rides on **error objects** (`enrichError` / `getErrorInstance`) via a
non-enumerable symbol property, which is how it survives to `uncaughtException` /
`unhandledRejection` handlers where ALS's ambient store is already gone.

---

## License

MIT

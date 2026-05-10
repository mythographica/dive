# @mnemonica/dive

**Execution Data Storage (EDS) — context propagation for mnemonica instances.**

WeakMap-based. No AsyncLocalStorage. No `async_hooks`.

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

The stress test proves context survival across random async boundaries:

```typescript
import { runStressTest } from '@mnemonica/dive/stress';

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

## Framework Adapters

Embedded but independent. Not exported from main module.

### NestJS

```typescript
import { createDiveExceptionFilter } from '@mnemonica/dive/adapters/nestjs';

@UseFilters(createDiveExceptionFilter())
export class MyController {}
```

### Fastify

```typescript
import { createDivePlugin } from '@mnemonica/dive/adapters/fastify';

app.register(createDivePlugin());
```

### Express

```typescript
import { createDiveMiddleware } from '@mnemonica/dive/adapters/express';

app.use(createDiveMiddleware());
```

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

## History

- **2018:** `context-dive` — `async_hooks` + manual callback patching
- **2020:** `AsyncLocalStorage` — native Node.js, 90% coverage
- **2025:** `@mnemonica/dive` — WeakMap + instance-bound context, no ALS

Motivation: [nodejs/diagnostics#249](https://github.com/nodejs/diagnostics/issues/249) —
synchronous execution splits break `async_hooks`-based CLS.

---

## License

MIT

# @mnemonica/dive

**Data + Flow for mnemonica instances.**

`uncaughtException` and `unhandledRejection` never know where they came from
or *which data* caused them. Dive answers that: context is pinned to userland
instances (**Data**), and every wrapped invocation appends an edge to a bounded
trace (**Flow**). When the Data Flow fails, the error is pinned to its deepest
trace edge — so the error carries both the data and the flow that happened to
it.

No AsyncLocalStorage. No `async_hooks`.

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
// Dive: the failure IS instance #73 — getErrorInstance(err) ✅
```

ALS stores one context per async resource. All timers, promises, and I/O
in the same request share the same store. When the request ends, the store
goes away. A queue consumer running 30 seconds later has **no context**.

### Dive Solution

```javascript
import { attachHooks, wrap, current, getFlow, getErrorInstance } from '@mnemonica/dive';
import { defaultTypes } from 'mnemonica';

attachHooks(defaultTypes); // records creation edges, auto-wraps instance methods

const instance = new MyType({ requestId: 'A', data: 42 });
// postCreation hook fires:
//   - a 'create' edge is appended to the trace
//   - instance methods are wrapped

// Any method call runs in the instance's context AND records a trace edge:
instance.process((result) => {
  current() === instance; // true ✅
});

// When processing FAILS, the error recovers everything:
try {
  instance.process();
} catch (err) {
  getErrorInstance(err); // → the instance (the data that caused it)
  getFlow(err);          // → [create:MyType, method:process] (the flow)
}
```

Dive captures context at **wrap-time** and restores + records it at
**invocation-time**. No async resource tracking needed. The instance
**is** the context — and the trace **is** its story.

---

## Installation

```bash
npm install @mnemonica/dive mnemonica
```

`mnemonica` is a peer dependency.

---

## Quick Start

```typescript
import { attachHooks, current } from '@mnemonica/dive';
import { defaultTypes } from 'mnemonica';

// One-line activation
attachHooks(defaultTypes);

// Now all instance methods run in their instance's context
const RequestData = defaultTypes.define('RequestData', function (this: { id: string }, data: { id: string }) {
  this.id = data.id;
});

const instance = new RequestData({ id: 'req-123' });
current() === instance; // true
```

---

## API

### `attachHooks(collection)`

```typescript
attachHooks(collection: TypesCollection): void;
```

Wire dive into a mnemonica types collection's lifecycle hooks:

- **preCreation** — enters the parent (`existentInstance`) context before the
  constructor runs, and wraps function arguments so callbacks handed to the
  constructor carry that context forward.
- **postCreation** — records the instance's `'create'` edge, parented on the
  **data-flow parent** (the parent instance's latest edge), then wraps the
  instance's methods.
- **creationError** — records a failed `'create'` edge (status `'error'`)
  under the surviving parent and pins the error to it.

### `wrap(fn, context?)`

```typescript
wrap<T extends (...args: unknown[]) => unknown>(fn: T, context?: object): T;
```

Capture context at wrap-time (explicit, or the current ambient context),
restore it at invocation-time, and record the invocation as a trace edge.

Handles `new` calls (via `Reflect.construct`), wraps returned functions,
wraps function arguments (recursively, to any depth), wraps Promise-resolved
functions, and pins rejections to the call's edge.

### `current()`

```typescript
current(): object | undefined;
```

The instance executing right now (the "newest-wins" switcher). Fine for
single-flow code. For anything concurrent, use `getFlow()` — the trace holds
the truth even when "current" is ambiguous.

### `getFlow(target?)`

```typescript
getFlow(): FlowEdge[];          // branch of the current cursor (empty at rest)
getFlow(error: Error): FlowEdge[];   // flight recorder: the branch that produced the error
getFlow(instance: object): FlowEdge[]; // the branch of that instance's latest edge
```

Reconstructs an execution branch from the trace, **oldest edge first**.
Returns copies — mutating them does not corrupt the trace.

```typescript
interface FlowEdge {
  id: number;
  parentId: number | null;
  instance: object | undefined;  // the data this edge happened to
  name: string;                  // type / method / function name
  kind: 'create' | 'call' | 'construct' | 'method';
  ts: number;                    // start time (Date.now())
  duration: number | undefined;  // ms, set when the invocation completes
  status: 'running' | 'ok' | 'error';
}
```

### `getErrorInstance(error)`

```typescript
getErrorInstance(error: Error): object | undefined;
```

The data pinned to an error. The error is pinned **once**, at the deepest
wrapped boundary it passed through — so this points at the failure site,
not at some outer re-throw.

### `setTraceLimit(limit)`

```typescript
setTraceLimit(limit: number): void; // default: 1024
```

Sets the ring-buffer size of the trace. `0` disables recording (context
switching still works; `getFlow()` returns empty branches). Shrinking evicts
the oldest edges immediately.

### `clear()`

```typescript
clear(): void;
```

Reset everything: trace, cursor, depth, context, trace limit, and any pending
Thunderstruck payloads. Useful for testing.

### `thunderstruck` — the Ahead-of-Construction Data Collector

```typescript
thunderstruck.feed(data: unknown): string; // → uuid
thunderstruck.collected: Map<string, unknown>; // getter: pending payloads
```

The boundary (a framework pipe/interceptor, a route handler, any entry point)
feeds raw request details **before** any mnemonica construction happens.
`feed` returns a uuid, which is passed through the invocation path; the
constructor of the root instance then picks its own payload out of
`.collected` by that uuid. No ALS, no async_hooks — the correlation key
travels explicitly.

Delivery is dive's only job: what the constructor does with the payload (wire
it into the root instance, build a pre-root chain, ignore it) is the user's
choice. Data wired into the instance during construction lives on with the
instance; everything left is **released at the next ROOT postCreation** — no
retention.

- Sub-constructions do **not** drain the store: a root constructor may build
  sub-instances before reading `.collected`.
- Async constructors are covered: postCreation fires after the construction
  promise resolves. (Core caveat: async handlers must `return this` — the
  default `awaitReturn` pattern. With `awaitReturn: false` and no return,
  core runs no post-processing and fires no postCreation at all.)
- A failed construction (`creationError`) does **not** release: the payload
  preceding a failure is exactly the data worth keeping.
- Payloads fed without any following root construction stay pending until the
  next root construction or `clear()` — so feed as close to construction as
  possible.

---

## The Execution-Flow Trace

The trace is what makes concurrent flows honest. Its parentage rule:

- **Depth > 0** (truly nested inside another wrapped invocation): the edge
  parents on the **cursor** — "Y called X" is recorded as it happened.
- **Depth === 0** (entered from an unwrapped boundary: timer, emitter, route
  handler): the edge parents on the **data** — the latest edge of the context
  instance. The cursor may hold a stale edge from an unrelated flow; trusting
  it would merge two requests into one branch.

Construction edges always parent on the **data-flow parent** (the parent
instance's own latest edge), so the trace forms a forest isomorphic to the
mnemonica instance chain:

```
create:RequestData ── create:RouteData ── method:load ── call:onLoaded
create:RequestData ── create:RouteData ── method:load ── error edge
```

Two requests interleaved in one process produce **separate branches** — the
old single-global-switcher clobbering cannot corrupt the trace, because the
switcher is never used for parentage.

---

## Stress Test

A stress scenario proves context survival across random async boundaries. It
is a test fixture (`test/stress/`), not a published entry point — run it with
`npm test` or read it as a worked example.

Flow:
1. Create 100 `StressEntity` instances with random values (each carries its
   `uuid` and `requestId` in its own data — no side maps)
2. Fisher-Yates shuffle, register 70% to global registry
3. Random consumer picks instances (20–100ms intervals)
4. ~55% success | ~17% sync throw | ~14% async reject | ~14% nested construction
5. Failures happen INSIDE wrapped boundaries → self-pinned errors
6. DLQ collects failures; every entry derives `requestId`/`uuid` from
   `getErrorInstance(error)` and proves a non-empty `getFlow(error)`

**Key result:** every failure is traceable back to the originating request —
data AND flow — even though instances were shuffled, queued, and processed
seconds later. The `test/uncaught-real.spec.ts` child-process test proves the
same across REAL `uncaughtException` / `unhandledRejection` boundaries, where
ALS's ambient store is gone.

---

## Framework Integration

There are no framework-specific adapters. Activation is one line — call
`attachHooks(defaultTypes)` once at startup, and every mnemonica instance
created while serving a request becomes context automatically (the instance
**is** the context). At decoupled boundaries (queues, timers, emitters),
`wrap()` the callback with the instance it processes — the failure will then
carry the data and the flow.

---

## ALS Comparison

| Scenario | ALS | Dive |
|----------|-----|------|
| Simple async chain | ✅ Works | ✅ Works |
| Synchronous instance creation | ❌ Loses context | ✅ Shifts per instance |
| setTimeout 30s later | ❌ Store gone | ✅ Context preserved |
| Random queue shuffle | ❌ No traceability | ✅ Every failure carries data + flow |
| Nested construction error | ❌ No parent context | ✅ Parent in error |
| Concurrent interleaved flows | ✅ Auto-isolated | ✅ Trace isolates; bare `current()` is newest-wins (documented) |
| Memory overhead | One store per async resource | Bounded ring buffer (`setTraceLimit`) |

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
| Property getters / setters | **Not supported** | Method wrapping only handles `descriptor.value`, not accessors |
| Generators / `yield` | **Use `wrap()`** | Each `yield` creates a suspension point; auto-wrapping requires intercepting `next()` |

### Why Not Auto-Wrap Everything?

Auto-wrapping every boundary causes a **cyclomatic / combinatory explosion** —
and it is not just performance overhead, it is **correctness overhead**. Deep
auto-wrapping:

- Wraps user-intentional plain objects (false positives)
- Breaks library code that expects unwrapped references
- Creates memory leaks if we hold strong refs to every returned object

### Manual Wrapping Is the Escape Hatch

For any boundary not auto-wrapped, use `wrap()` explicitly:

```typescript
// Arrays containing callbacks
const wrappedHandlers = handlers.map(fn => wrap(fn, instance));

// setTimeout
setTimeout(wrap(() => processTask(), instance), 1000);

// Event emitters
emitter.on('data', wrap(onData, instance));
```

### Generators and `yield`

Generators create a **suspension boundary** at every `yield`. Dive does not
auto-wrap them because `yield` can fire across arbitrary async boundaries.
Manually wrap each resumption:

```typescript
function* myGenerator() {
  yield step1();
  yield step2();
}

const gen = myGenerator();
const result1 = wrap(() => gen.next(), instance)(); // step1 runs with instance as context
const result2 = wrap(() => gen.next(), instance)(); // step2 runs with instance as context
```

For async generators, wrap the resumptions the same way — the `async` keyword
does not change the wrapping semantics.

### The Rule of Thumb

> If the execution flow **passes through a function call**, Dive can track it.
> If the flow **escapes through a non-function boundary** (array slot, event emitter, stream), use `wrap()` manually.

This keeps Dive predictable, fast, and correct.

---

## History

- **2018:** `context-dive` — `async_hooks` + manual callback patching
- **2020:** `AsyncLocalStorage` — native Node.js, 90% coverage
- **2025:** `@mnemonica/dive` v0.1 — object-bound context, no ALS (single-global switcher)
- **2026:** v0.2 redesign — the switcher demoted to a cursor over a bounded
  execution-flow trace; construction edges parent on the data-flow lineage;
  the identifier-map subsystem (`link`/`unlink`) removed — the data carries
  its own identity, and errors carry the data. API simplified to 7 functions.

Motivation: [nodejs/diagnostics#249](https://github.com/nodejs/diagnostics/issues/249) —
synchronous execution splits break `async_hooks`-based CLS.

---

## Internals

The store is four parts (no `async_hooks`):

- `edges` — a `Map<id, FlowEdge>` **ring buffer** (oldest evicted past
  `traceLimit`, default 1024). Edges hold strong references to their instances
  until evicted, so the buffer size IS the memory bound.
- `cursor` — the id of the edge executing right now (`null` at rest), plus
  `activeDepth` tracking how deep we are inside wrapped invocations. Depth
  decides parentage (see "The Execution-Flow Trace").
- `latestEdge` — a `WeakMap<instance, edgeId>` with each instance's most
  recent edge, so construction and method calls continue the instance's own
  story. Weak, so instances are never pinned by this map.
- `lastContext` — the "newest-wins" switcher behind `current()`. Deliberately
  NOT used for trace parentage: concurrent flows may clobber the switcher,
  but they cannot corrupt the trace.

Context also rides on **error objects** via two non-enumerable symbol
properties (`mnemonica.dive.edge`, `mnemonica.dive.instance`), pinned once at
the deepest wrapped boundary the error passes through — which is how data and
flow survive to `uncaughtException` / `unhandledRejection` handlers where
ALS's ambient store is already gone.

Method wrapping is applied to the instance's immediate **prototype**, using
`this` (the receiver) as the context. For plain classes — where many instances
share one prototype — each method is wrapped ONCE. Mnemonica gives every
instance its own immediate prototype, so for mnemonica instances this is still
per-instance; it is not worse, just not a win.

---

## License

MIT

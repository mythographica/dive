# @mnemonica/dive

**Data + Flow for userland instances.**

`uncaughtException` and `unhandledRejection` never know where they came from
or *which data* caused them. Dive answers that: context is pinned to userland
instances (**Data**), and every wrapped invocation appends an edge to a bounded
trace (**Flow**). When the Data Flow fails, the error is pinned to its deepest
trace edge — so the error carries both the data and the flow that happened to
it.

No AsyncLocalStorage. No `async_hooks`.

Successor to [`context-dive`](https://www.npmjs.com/package/context-dive) (2018).

---

## Before You Start

Dive is **standalone**: it imports nothing at all and works with
any objects you choose as context. Used with
[mnemonica](https://www.npmjs.com/package/mnemonica) — the instance-inheritance
library whose types carry their construction context (data flow) with them —
it becomes automatic: every constructed instance is its own context. That
wiring lives in the
[@mnemonica/nestjs](https://www.npmjs.com/package/@mnemonica/nestjs) adapter
(`attachHooks`), not in dive itself.

The ecosystem:

- [mnemonica](https://www.npmjs.com/package/mnemonica) — the core: typed
  instance inheritance, lifecycle hooks, composite error stacks.
- [@mnemonica/nestjs](https://www.npmjs.com/package/@mnemonica/nestjs) — the
  NestJS adapter: `attachHooks()` (dive ↔ mnemonica lifecycle wiring),
  module system, pipes, interceptors, Thunderstruck boundary feeding.
- [typeomatica](https://www.npmjs.com/package/typeomatica) — runtime
  strict-type enforcement for instance fields (Proxy-based). Companion for
  construction-time data integrity.
- [@mnemonica/tactica](https://www.npmjs.com/package/@mnemonica/tactica) —
  the compile-time side: generates the TypeScript registry so `lookup()` and
  `define()` are fully typed.

---

## The Paradigm Shift

```
ALS:  context is bound to the async resource (timer, I/O, HTTP request)
Dive: context is bound to the INSTANCE — any object you choose
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
import { wrap, current } from '@mnemonica/dive';
import { getFlow, getErrorInstance } from '@mnemonica/dive';
// the mnemonica ↔ dive wiring lives in the adapter:
import { attachHooks } from '@mnemonica/nestjs';
import { defaultTypes } from 'mnemonica';

// records creation edges, auto-wraps instance methods
attachHooks(defaultTypes);

const instance = new MyType({ requestId: 'A', data: 42 });
// postCreation hook fires:
//   - a 'create' edge is appended to the trace
//   - instance methods are wrapped

// Any method call runs in the instance's context
// AND records a trace edge:
instance.process((result) => {
  current() === instance; // true ✅
});

// When processing FAILS, the error recovers everything:
try {
  instance.process();
} catch (err) {
  // → the instance (the data that caused it)
  getErrorInstance(err);
  // → [create:MyType, method:process] (the flow)
  getFlow(err);
}
```

Dive captures context at **wrap-time** and restores + records it at
**invocation-time**. No async resource tracking needed. The instance
**is** the context — and the trace **is** its story.

---

## Installation

```bash
# standalone — zero dependencies of any kind
npm install @mnemonica/dive

# with mnemonica — the adapter carries the lifecycle wiring
npm install @mnemonica/dive @mnemonica/nestjs mnemonica
```

Dive has no dependency on mnemonica at all — not even a peer one. The two
meet only inside `@mnemonica/nestjs`, which depends on both.

---

## Quick Start

Standalone — any object can be the context:

```typescript
import { wrap, current, getErrorInstance } from '@mnemonica/dive';

const job = { id: 'req-123' };

// capture the context now; it is restored at invocation time
const process = wrap(() => {
  current() === job; // true
}, job);

// even 30 seconds later, from a decoupled queue consumer:
setTimeout(process, 30_000);
```

With mnemonica, construction itself becomes the context switch — via the
adapter's `attachHooks`:

```typescript
import { attachHooks } from '@mnemonica/nestjs';
import { current } from '@mnemonica/dive';
import { defaultTypes } from 'mnemonica';

// one-line activation: creation edges + auto-wrapped methods
attachHooks(defaultTypes);

const RequestData = defaultTypes.define(
  'RequestData',
  function (this: { id: string }, data: { id: string }) {
    this.id = data.id;
  }
);

const instance = new RequestData({ id: 'req-123' });
current() === instance; // true
```

---

## API

### `attachHooks(collection)` — moved to `@mnemonica/nestjs`

The mnemonica lifecycle wiring is adapter-level code, not engine code. It now
ships as [`@mnemonica/nestjs`](https://www.npmjs.com/package/@mnemonica/nestjs):

```typescript
import { attachHooks } from '@mnemonica/nestjs';
attachHooks(collection); // preCreation + postCreation + creationError
```

Dive exports the primitives that wiring is built from, for custom
integrations (other frameworks, non-Nest mnemonica apps, your own lifecycle
events):

| Primitive | Called when |
|---|---|
| `enterContext(instance)` | a lifecycle event enters an instance's context |
| `wrapConstructorArg(fn, context)` | a constructor receives a callback argument |
| `upgradeConstructorArg(arg, instance)` | construction finished; unused callbacks now belong to the instance |
| `wrapInstanceMethods(instance)` | an instance should run methods in its own context |
| `recordCreation(name, instance, parent?)` | construction succeeded — `'create'` edge under data-flow parentage |
| `recordCreationError(name, error, parent?)` | construction failed — error pinned to the failed edge |
| `isWrappedFunction(fn)` | guard against double-wrapping |

### `wrap(fn, context?)`

```typescript
wrap<T extends (...args: unknown[]) => unknown>(
  fn: T,
  context?: object
): T;
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
// branch of the current cursor (empty at rest)
getFlow(): FlowEdge[];
// flight recorder: the branch that produced the error
getFlow(error: Error): FlowEdge[];
// the branch of that instance's latest edge
getFlow(instance: object): FlowEdge[];
```

Reconstructs an execution branch from the trace, **oldest edge first**.
Returns copies — mutating them does not corrupt the trace.

```typescript
interface FlowEdge {
  id: number;
  parentId: number | null;
  // the data this edge happened to
  instance: object | undefined;
  // type / method / function name
  name: string;
  kind: 'create' | 'call' | 'construct' | 'method';
  // start time (Date.now())
  ts: number;
  // ms, set when the invocation completes
  duration: number | undefined;
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
// default: 1024
setTraceLimit(limit: number): void;
```

Sets the ring-buffer size of the trace. `0` disables recording (context
switching still works; `getFlow()` returns empty branches). Shrinking evicts
the oldest edges immediately.

### `clear()`

```typescript
clear(): void;
```

Reset everything: trace, cursor, depth, context, and trace limit.
Useful for testing.

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

For NestJS there is a dedicated adapter:
[`@mnemonica/nestjs`](https://www.npmjs.com/package/@mnemonica/nestjs) —
module system, validation pipe, interceptors, and `attachHooks()` (the dive ↔
mnemonica lifecycle wiring). `MnemonicaModule.forRoot({ thunderstruck: true })`
activates the whole bundle.

Outside NestJS, call `attachHooks(collection)` from the same package once at
startup, and every mnemonica instance created while serving a request becomes
context automatically (the instance **is** the context). At decoupled
boundaries (queues, timers, emitters), `wrap()` the callback with the
instance it processes — the failure will then carry the data and the flow.
For anything else, the integration primitives (see API) let you wire dive
into your own lifecycle events.

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

## The async_hooks Isomorphism

Dive knowingly re-uses the **shape** of async_hooks — and inverts what it
attaches to:

| async_hooks | dive |
|---|---|
| `asyncId` | edge `id` |
| `triggerAsyncId` | edge `parentId` |
| `executionAsyncId()` | the trace `cursor` |
| `init` / `before` / `after` / `destroy` | `wrap()` entry/exit bookkeeping |
| `AsyncLocalStorage` store | `lastContext` behind `current()` |

The difference is the attachment point. async_hooks parents the graph on
**async resources** — timers, promises, I/O handles the runtime created — and
instruments *everything* from inside the runtime, whether you asked or not;
`AsyncLocalStorage` then tries to filter that noise back down. Dive parents
the graph on **invocations carrying data** — and wraps only what you
explicitly wrapped, from userland. The default is silence; you pay per wrap.

This is also why dive survives the synchronous split
([nodejs/diagnostics#249](https://github.com/nodejs/diagnostics/issues/249))
that breaks async_hooks-based CLS: at a sync boundary no async resource is
created, so there is nothing to hook — but the invocation still happens, and
dive's context lives on the instance, not on the resource.

There is a cautionary prequel here. In the diagnostics-WG era, Thomas Watson
described monkeypatching Node's own bootstrap — down at the serializer layer
— to wrap everything for tracing. The result was combinatorial bloom:
instrument-everything pays for *everything*, and the traces drown in their
own exhaust. Dive's answer to that story is the opt-in model: the same graph
shape, but hung from data you chose, at boundaries you chose.

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
// step1 runs with instance as context
const result1 = wrap(() => gen.next(), instance)();
// step2 runs with instance as context
const result2 = wrap(() => gen.next(), instance)();
```

For async generators, wrap the resumptions the same way — the `async` keyword
does not change the wrapping semantics.

### The Rule of Thumb

> If the execution flow **passes through a function call**, Dive can track it.
> If the flow **escapes through a non-function boundary** (array slot, event emitter, stream), use `wrap()` manually.

This keeps Dive predictable, fast, and correct.

---

## Boundaries

Execution flow spans more than one runtime. A request's story may cross a
database, a message queue, or another service — and each of those runtimes
traces its own path in its own way. Dive's single responsibility is **this**
runtime: the process, in memory.

The reason is structural. Dive pins context to **object identity** — the
instance and the error object, tracked via a `WeakMap` and symbol properties.
Serialization destroys identity: what comes back from the database is a *new*
object with the same field values, and no library can tell from the object
alone that it descends from request 42. This is not a gap to fix; it is the
boundary every in-process tracer shares, ALS included.

The contract between runtimes is a **correlation key carried as data**:

1. Carry the identifier *in the payload* (e.g. a `uuid` stored with the DB
   record) — it survives because it travels as data, not as identity.
2. On read-back, construct the mnemonica type from the record
   (`new RequestData(dbRecord)`): dive tracking resumes from that point, and
   the uuid links the new flow branch back to the original one.
3. Across the wire, let the tracer built for it do its job: the
   `@mnemonica/nestjs` adapter emits OpenTelemetry spans carrying
   `dive.instance.uuid`, so Jaeger stitches what dive cannot see.

Where dive differs from ALS is *which* in-process boundary it pins to. ALS
binds context to the async **resource** chain — ambient, correct only while
every library propagates perfectly, and already gone when `uncaughtException`
fires. Dive pins to the **object graph** — which is why attribution survives
process-level escapes and arbitrary queue reordering.

### Falsifiable, not "trust us"

Every claim above is gated by a script that exits non-zero on any
misattribution:

| Proof | Where | What it gates |
|-------|-------|---------------|
| Stress suite | `npm test`, this repo | shuffle + queue + DLQ attribution; real process-level escapes in a child process |
| `load:proof` | FineCut pilot (`finecut/nest-dive`) | 200 unique-marker crashes over real TCP, 50 in flight, zero misattribution |
| `proof:queue` | FineCut pilot (`finecut/nest-dive`) | 140 markers through a random-order, random-delay queue — request 42 stays 42 |

Falsifiable means there is a way to research further — not that nothing
works. Something works, and these instruments will say so the day it stops.

---

## History

- **2018:** [`context-dive`](https://www.npmjs.com/package/context-dive) —
  `async_hooks` + manual callback patching (the HolyJS 2018 talk package)
- **2020:** `AsyncLocalStorage` — native Node.js, 90% coverage
- **2025:** `@mnemonica/dive` v0.1 — object-bound context, no ALS
  (single-global switcher)
- **2026:** v0.2 redesign — the switcher demoted to a cursor over a bounded
  execution-flow trace; construction edges parent on the data-flow lineage;
  the identifier-map subsystem (`link`/`unlink`) removed — the data carries
  its own identity, and errors carry the data. API simplified to 7 functions.
- **2026:** v0.3 — the engine/adapter split, completed. Dive is a palette of
  wrappers and imports nothing at all; the mnemonica-specific `attachHooks`
  moved to `@mnemonica/nestjs`, rebuilt from dive's exported integration
  primitives. `thunderstruck` (pre-root payload collection) moved out with
  it — dive was never meant to be a storage. The adapter keeps those
  payloads in a `WeakMap` keyed on request objects: GC is the only release,
  and retention is exactly the request's lifetime.
- **2026:** async edge closure — the promise tap now closes the edge
  (`'ok'` + full-lifetime `duration`) when the whole chain settles, and
  `'running'` means *genuinely unsettled*. The domain vocabulary
  (statuses, kinds, fallback names) was hoisted to single-definition
  constants.

Motivation: [nodejs/diagnostics#249](https://github.com/nodejs/diagnostics/issues/249) —
synchronous execution splits break `async_hooks`-based CLS.

The design decision log — considered-and-rejected alternatives, parked
designs, and when to revisit them — lives in
[DECISIONS.md](https://github.com/mythographica/dive/blob/main/DECISIONS.md) in the repository.

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

---

# Explanation

This is the whole machinery in execution order. The implementation is one
file (`src/index.ts`, ~630 lines, no imports).

## 0. The shape

Dive is not a class or an object — it's **module-level mutable state plus
functions**. The entire store is five `let` bindings at the top of the file:

- `edges: Map<id, FlowEdge>` — the trace itself (a ring buffer; the oldest
  entries are evicted past `traceLimit`)
- `latestEdge: WeakMap<instance, edgeId>` — "where this instance's story
  last continued"
- `cursor: number | null` — the edge executing **right now**
- `activeDepth: number` — how many wrapped invocations deep we are
- `lastContext` — the newest-wins switcher behind `current()`

## 1. The entrypoint

There is no start function. Dive is inert until **a wrapped function is
invoked**. In a mnemonica app the *wiring* entrypoint is
`attachHooks(collection)` (adapter side), which registers mnemonica
lifecycle hooks — but those hooks themselves only call dive primitives. So
the real entrypoint, always, is: **somebody calls a function that `wrap()`
returned.**

## 2. `wrap(fn, context?)` — the heart

Two phases. **Wrap time** (once): capture the context — explicit argument,
or whatever `lastContext` is right then. Already-wrapped functions pass
through untouched.

**Call time** — every invocation of the wrapped function:

1. Save `previousContext` / `previousCursor`; set
   `lastContext = capturedContext`.
2. `recordEdge(...)` appends a `FlowEdge`
   `{id, parentId, instance, name, kind, ts, status:'running'}`. The parent
   comes from `executionParent(context)` — see step 3 below.
3. `cursor = edge.id; activeDepth++` — we are now inside a wrapped
   invocation.
4. **Wrap the args**: any function passed *into* this call gets wrapped
   with the same context — context propagates **down**.
5. Call the real `fn` — via `Reflect.construct` if invoked with `new`.
6. If the result is a **function**, wrap it — context propagates
   **forward**.
7. If the result is a **Promise**, tap it: the edge closes
   (`'ok'` + full-lifetime duration) when the whole chain settles — a
   promise never resolves *to* a promise, the runtime flattens thenables
   before the tap fires, so promise-in-promise needs no wrapping of its
   own — resolved functions get wrapped, rejections get
   `pinError(error, edge, context)` then re-throw.
8. Sync throw → `pinError`, rethrow.
9. `finally`: restore `cursor`, `activeDepth--`, restore `lastContext`
   (for promises, `duration` is stamped at settlement by step 7's tap).
   The state machine is back exactly where the caller left it.

Steps 4+6 are the ALS replacement: propagation is not ambient, it's
**viral through values** — every wrapped call wraps its inputs and outputs,
so context chains to any depth without touching the runtime.

## 3. The parentage rule — `executionParent`

- **`activeDepth > 0`**: we're truly nested inside another wrapped call →
  parent is the `cursor`. "Y called X" is recorded as it happened.
- **`activeDepth === 0`**: we entered from an **unwrapped boundary**
  (setTimeout fired, emitter called, route handler) — the cursor may be a
  stale edge from some *other* request. So the edge parents on the
  **data**: `latestEdge.get(context)` — the context instance's own most
  recent edge.

This is the line that makes the queue proof possible: interleaved requests
can clobber `lastContext` and even the cursor, but a fresh edge at a
boundary continues *its instance's* story, never a stranger's.

## 4. The error path — `pinError`

Every edge an error propagates through gets `status = 'error'` — but the
error **object** is pinned only **once** (if the symbol's already there,
return). Deepest boundary wins; outer re-throws can't overwrite the failure
site. Two non-enumerable symbols go onto the error: `mnemonica.dive.edge`
(edge id) and `mnemonica.dive.instance` (the data). That's the whole trick
behind crash attribution: the error *carries* its provenance, so
`uncaughtException` — where ALS's store is long dead — can still recover
everything.

## 5. The read paths

- `current()` — just `lastContext`. Honest but newest-wins; ambiguous under
  concurrency by design.
- `getFlow(target)` — resolve a starting edge (cursor / error's pinned
  edge / instance's latest edge), then walk `parentId` upward, `unshift`ing
  into an array → the branch, oldest first.
- `getErrorInstance(err)` — pinned instance; fallback: the instance of the
  pinned edge.

## 6. How mnemonica instances enter the picture — `attachHooks` (adapter)

- **preCreation**: `enterContext(parent)` + `wrapConstructorArg` on
  function args — callbacks handed to a constructor carry context, via a
  mutable holder so they can be re-pointed at the not-yet-built instance.
- **postCreation**: `recordCreation(name, instance, parent)` → a `create`
  edge parented on the *parent instance's* latest edge (data-flow lineage);
  then `wrapInstanceMethods(instance)` redefines every method on the
  instance's immediate prototype with the same bookkeeping as `wrap()` but
  `kind:'method'` and **context = the receiver `this`**;
  `upgradeConstructorArg` re-points unused arg callbacks at the built
  instance.
- **creationError**: `recordCreationError` — a failed `create` edge under
  the surviving parent, error pinned to it.

## 7. End-to-end: one queue-proof request

1. `POST /proof` → `new ProofEntity({uuid, marker, expect})`.
   preCreation/postCreation fire → `create:ProofEntity` edge; `process`
   gets wrapped on the prototype. HTTP response leaves. *Request cycle
   over.*
2. Seconds later, a `setTimeout` tick fires (unwrapped boundary, depth 0) →
   `instance.process()` → wrapped method records `method:process`,
   **parented on that instance's own `create` edge**, not on whatever ran
   last.
3. `await` random delay → `throw` for marker 57 → the promise tap pins the
   error to *this* edge + *this* instance → rethrows.
4. The queue's `catch` calls `recordFailure(err)` →
   `getErrorInstance(err)` → the instance → `utils.extract` →
   `{uuid, marker}` → outcome stored.
5. `GET /proof/:uuid` reads it back. The script asserts the marker matches
   what *it* sent — which it can only do if step 2's parentage and step 3's
   pinning never crossed wires.

That's the whole loop: **wrap at boundaries, record edges, parent on data,
pin errors once, read from the error.** Everything else in the file
(`setTraceLimit`, `clear`) is housekeeping.

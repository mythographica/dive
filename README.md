# @mnemonica/dive

**Data + Flow for userland instances.**

`uncaughtException` and `unhandledRejection` never know where they came from
or *which data* caused them. Dive answers that: context is pinned to userland
instances (**Data**), and every wrapped invocation records an edge that links
to its parent (**Flow**). When the Data Flow fails, the error is pinned to
its deepest trace edge — so the error carries both the data and the flow
that happened to it.

No AsyncLocalStorage. No `async_hooks`.

---

## Before You Start

Dive is **standalone**: it imports nothing at all and works with
any objects you choose as context. Used with
[mnemonica](https://www.npmjs.com/package/mnemonica) — the instance-inheritance
library whose types carry their construction context (data flow) with them —
it becomes automatic: every constructed instance is its own context. That
wiring lives in
[@mnemonica/otel](https://www.npmjs.com/package/@mnemonica/otel)
(`attachHooks`), not in dive itself — the NestJS adapter re-exports it.

The ecosystem:

- [mnemonica](https://www.npmjs.com/package/mnemonica) — the core: typed
  instance inheritance, lifecycle hooks, composite error stacks.
- [@mnemonica/otel](https://www.npmjs.com/package/@mnemonica/otel) — the
  framework-free Node engine where dive meets mnemonica: `attachHooks()`
  (the dive ↔ mnemonica lifecycle wiring), OTel providers, the ALS
  async-flow backbone, the pre-root store.
- [@mnemonica/nestjs](https://www.npmjs.com/package/@mnemonica/nestjs) — the
  NestJS adapter layered on otel: module system, pipes, interceptors,
  Thunderstruck boundary feeding.
- [typeomatica](https://www.npmjs.com/package/typeomatica) — runtime
  strict-type enforcement for instance fields (Proxy-based). Companion for
  construction-time data integrity.
- [@mnemonica/tactica](https://www.npmjs.com/package/@mnemonica/tactica) —
  the compile-time side: generates the TypeScript registry so `lookup()` and
  `define()` are fully typed.
- [@mnemonica/strategy](https://www.npmjs.com/package/@mnemonica/strategy) +
  [mnemographica](https://github.com/mythographica/mnemographica) — the
  read-out path: strategy streams the trace out of a running process (WS
  channel, no CDP needed when the app self-hosts), mnemographica renders it
  (Live Trace sidebar, 3D trace bulbs).

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
// the mnemonica ↔ dive wiring lives in the observability engine:
import { attachHooks } from '@mnemonica/otel';
import { defaultTypes } from 'mnemonica';

// records creation edges, auto-wraps instance methods
attachHooks(defaultTypes);

const instance = new MyType({ requestId: 'A', data: 42 });
// postCreation hook fires:
//   - a 'create' edge is recorded
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

# with mnemonica — the otel package carries the lifecycle wiring
npm install @mnemonica/dive @mnemonica/otel mnemonica
```

Dive has no dependency on mnemonica at all — not even a peer one. The two
meet inside `@mnemonica/otel` (framework-free) or `@mnemonica/nestjs` (the
NestJS adapter), which depend on both.

**CommonJS consumers** (e.g. jest ≤29 test runs): the package dual-builds —
`require('@mnemonica/dive')` resolves to `build-cjs/` automatically via the
exports map, no mocks or `transformIgnorePatterns` needed. ESM stays the
default for everything else.

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
import { attachHooks } from '@mnemonica/otel';
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

### `wrap(fn, context?)` / `wrap(fn, label?)` / `wrap(fn, context, label)`

```typescript
wrap<T extends (...args: unknown[]) => unknown>(
  fn: T,
  context?: object,
  label?: string
): T;
```

Capture context at wrap-time (explicit, or the current ambient context),
restore it at invocation-time, and record the invocation as a trace edge.
Which of the two happened is recorded on the edge as `instanceSource`
(`'explicit' | 'ambient'`): the ambient fallback is newest-wins and
best-effort, so consumers can distrust it under concurrency.

The optional `label` is a grouping tag for tooling (one label may group many
names). Every wrap also captures its **callsite** (`file:line:col`, plain
path) once at wrap time — the runtime half of the join into tactica's
`eds.json` probe registry, which uses the same location format. Edges carry
both as `edge.label` / `edge.callsite`, and the edge `name` follows the
caption cascade:

- label + named fn → `label:name`
- label + anonymous fn → the callsite (the label survives on `edge.label`)
- no label → `fn.name`, falling back to the callsite, then `'anonymous'`

Re-rooting (`wrap(w, differentContext)`) preserves the ORIGINAL wrap's
label/callsite: a bulb's identity is where it was first wrapped.

Handles `new` calls (via `Reflect.construct`), wraps returned functions,
wraps function arguments (recursively, to any depth), wraps Promise-resolved
functions, and pins rejections to the call's edge.

Re-wrapping an already wrapped function follows **scope shadowing**:

- `wrap(w)` or `wrap(w, sameContext)` — idempotent, returned as-is.
- `wrap(w, differentContext)` — the callback changes ownership: a
  `'recontext'` handoff edge is recorded on the new context (parented on
  the old context's latest retained edge), and a fresh wrapper around
  the ORIGINAL function is returned — wrappers never stack. Existing references
  to the old wrapper keep telling the old story.
- Function arguments crossing wrapped calls are auto-wrapped idempotently —
  they never shadow. Re-rooting is always your explicit act.

```typescript
const w1 = wrap(job, requestInstance);
service.register(wrap(w1, serviceInstance));
// handoff recorded: getFlow(serviceInstance) walks back through the
// 'recontext' edge into requestInstance's branch
```

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

Reconstructs an execution branch by walking edge-to-edge object links,
**oldest edge first**. Returns copies — mutating them does not corrupt the
trace. A branch reaches back exactly as far as something alive kept it: a
held `Error`, a pending timer's closure, the context instance itself.

```typescript
interface FlowEdge {
  id: number;
  parentId: number | null;
  // the data this edge happened to
  instance: object | undefined;
  // type / method / function name
  name: string;
  kind: 'create' | 'call' | 'construct' | 'method' | 'recontext';
  // start time (Date.now())
  ts: number;
  // ms, set when the invocation completes
  duration: number | undefined;
  status: 'running' | 'ok' | 'error';
  // grouping tag / wrap site, when given
  label?: string;
  callsite?: string;
  // how the instance was attributed: passed by the caller, or captured
  // from the newest-wins ambient (best-effort — distrust it under
  // concurrency); undefined when the edge carries no instance
  instanceSource?: 'explicit' | 'ambient';
}
```

### `getErrorInstance(error)`

```typescript
getErrorInstance(error: Error): object | undefined;
```

The data pinned to an error. The error is pinned **once**, at the deepest
wrapped boundary it passed through — so this points at the failure site,
not at some outer re-throw.

### `getRunningEdges()`

```typescript
getRunningEdges(): FlowEdge[];
```

The edges still `running` right now — the unfinished fibers. This is the
suspect set for `uncaughtException` / `unhandledRejection` attribution,
queryable in O(1) without walking parents. Copies, same semantics as
`getFlow()`. Entries are born at edge creation and removed at settle
(sync return, promise settle, error mark), so the store is bounded by
true concurrency and leaks nothing when nobody consumes it.

Note for tooling: construction edges (`kind: 'create'`) are recorded at
postCreation — the construction has already completed — so they are born
settled and never appear here. `running` answers "which *calls* are still
in flight".

### `stats`

```typescript
stats: {
  readonly running: number;             // edges running right now
  readonly recorded: number;            // edges recorded this era
  readonly collectedEdges: number;      // edges GC collected (see below)
  readonly alive: number;               // recorded − collectedEdges
  readonly collectedInstances: number;  // instances GC collected
}
```

Read-only getter fields for tests, benchmarks, and live probes. The two
`collected*` counters are reported by `FinalizationRegistry` callbacks, so
they lag a GC by one task — force GC, yield one macrotask, then read.
`clear()` starts a new era (counters reset).

`alive` is the honest answer to "is anything pinning the trace": after
load drains and GC runs, it falls to the depth of the most recent
request's chain — the cursor holds the last edge, and each edge's parent
link keeps its own parent alive. A fixed, chain-depth-sized residue that
each new request replaces wholesale.

### Instance references are weak

`edge.instance` is a `WeakRef` deref behind a getter, and every recorded
instance is registered with a `FinalizationRegistry` — when GC collects
the instance, `stats.collectedInstances` advances. Retention is
object-linked: an edge lives exactly as long as something alive keeps it —
its instance, a held `Error` pinned to it, a pending timer's closure, or
its own parent chain up from the cursor. There is no buffer to bound and
no limit to tune; GC reachability IS the memory bound.

**Payload survival is per-object, not per-fiber.** A fiber that carries
ONE context instance through all its edges (the common case — one DATA
flowing through wraps) keeps every edge's payload alive while ANY single
reference to that instance exists anywhere: a pending timer's closure, a
suspended `await` frame, the unwinding crash stack. Edges pointing at
*different* instances have independent fates. Trade-off: `getFlow()` /
`getErrorInstance()` on an old branch may deref to `undefined` — snapshot
instance data at settle/error time if you need postmortem payloads.

**Crash-time delivery contract:** at `uncaughtException` /
`unhandledRejection`, the crashing fiber's payloads ARE alive (the crash
path itself roots them) — but only until the handler returns. So extract
and ship INSIDE the handler, synchronously; a consumer that polls later
may find payloads collected. The live surfaces (`getRunningEdges()`,
`stats`) are the present tense; your crash handler's export (Jaeger,
mnemographica) is the postmortem store.

### `chainDepth(target?)`

```typescript
chainDepth(target?: unknown): number;
```

`getFlow(target).length` without copying a single edge — for tests and
benchmarks asserting how long a chain something alive keeps.

### `edge.drop(...targets)`

```typescript
// on any edge returned by getFlow()/getRunningEdges()
edge.drop();          // wipe the whole trace
edge.drop(o1, o2, …); // remove only these objects from the trace
```

Explicit trace eviction, walked from the edge UP to the root. `drop()`
makes the entire trace collectable now instead of whenever the objects
happen to die: every edge on the walk loses its parent link, its object
anchor, and its instance ref; running edges leave the running store. After
it, `getFlow(edge)` is just `[edge]` and everything collects as soon as
nothing outside holds it. **Price, stated plainly:** an Error pinned to
any edge of a wiped trace keeps ONLY its own edge — `getFlow(error)` no
longer reaches the request's story. That is the cost of the explicit
wipe; choose the moment accordingly (after the crash handlers ran, not
before).

`drop(o1, o2, …)` is the targeted form: the same walk, but only the given
objects are removed — edges carrying one of them lose its instance ref,
and the object's continuation point (its anchor into the trace) is
deleted. Edges, parent links, siblings, successors, and every other
object stay. If the objects you name are not what anchors the trace,
memory stays held — by design; use the walk below to see what anchors
what.

No return value; non-object arguments are ignored (and do NOT trigger a
wipe); calling twice is a no-op.

### `clear()`

```typescript
clear(): void;
```

Reset everything: object links, the running store, cursor, depth, context,
counters, and the registered lifecycle hooks. Useful for testing —
adapter-level subscribers must re-register after a `clear()`.

### `registerHook(event, hook)`

```typescript
const unregister = registerHook('enter', (payload) => { /* ... */ });
unregister();
// or, by reference, when the closure was not kept:
unregisterHook('enter', myHook);
```

Dive **publishes** its ground truth — emission, never ingestion. Subscribers
(ALS/OTel vendors, monitoring layers) correlate from THEIR side at the one
moment both trees share a frame; dive never imports `async_hooks` and never
trusts external propagation. Same shape and philosophy as mnemonica's own
`registerHook`. Detach via the returned unregister function, or with
`unregisterHook(event, hook)` when the closure was not kept (no-op for
unknown hooks).

Hooks fire only when an edge is recorded. Dispatch cost when nobody is
subscribed is one length check per edge.

Events:

- **`enter`** — right after the edge is recorded, while `cursor` and
  `lastContext` hold the truthful values. Payload: the fresh **edge object
  itself** (attach your own symbols to it — a span id gives you the reverse
  join for free) plus the invocation `args` by reference.
- **`leave`** — the sync close, with the edge's final `status`/`duration` and
  what the wrap produced (plain value / wrapped function / tapped promise;
  `undefined` when the call threw).
- **`settle`** — when a tapped promise chain closes: `result` on resolution,
  `error` on rejection. Distinct from `leave`, so "the sync head returned" is
  never confused with "the work is done".
- **`recontext`** — a re-wrap handoff: the callback changed ownership, and
  the payload (`fn`, `previousContext`, `context`, plus the handoff edge) links the
  old context's story to the new one.
- **`create`** — *opt-in*: a construction edge recorded via
  `recordCreation`/`recordCreationError`. Deliberately **not** an `enter` —
  that lifecycle is the adapter's own mnemonica-hook domain, and
  re-publishing it as `enter` would double-report there. `create` exists for
  third-party subscribers that are **not** the adapter; `error` is set on the
  `recordCreationError` path.

Subscriber exceptions are contained per-subscriber: a throwing hook degrades
its own observability, never the trace.

```typescript
import { registerHook } from '@mnemonica/dive';

// correlate an OTel span with every wrapped call
registerHook('enter', ({ edge, args }) => {
  const span = tracer.startSpan(edge.name);
  (edge as Record<symbol, unknown>)[SPAN] = span;
});
registerHook('settle', ({ edge, error }) => {
  const span = (edge as Record<symbol, unknown>)[SPAN] as Span | undefined;
  if (error) span?.recordException(error);
  span?.end();
});
```

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

## Long-lived objects keep their whole story

Retention is per context object. A short-lived request instance collects
the moment nothing references it — but an object that lives for the whole
process (a service singleton, a connection pool, a cache) accumulates
**one chain link per wrapped call made on it**, and the whole chain stays
reachable for as long as the object does. Measured (`test/long-lived-chain.spec.ts`,
100,000 finished wrapped calls, forced GC between phases):

| Scenario | `stats.alive` after GC | `stats.collectedEdges` | heap |
|---|---|---|---|
| one object held for the whole run | 100,000 | 0 | 35.8 MB |
| a fresh short-lived object per call | 0 | 100,000 | 15.4 MB |
| one held object, then `edge.drop(obj)` on the newest edge | 0 | 100,000 | 19.5 MB |
| one held object, then `edge.drop()` on the newest edge | 0 | 100,000 | 15.6 MB |

In both drop rows the object itself stays held — after the drop its
continuation point is gone (`chainDepth(obj)` is 0) and its next call
starts a fresh story at depth 1. On a single-object trace the targeted and
the full wipe converge (every edge carried that object, and its anchor was
the trace's only root); with several objects on one trace, `drop(obj)`
keeps the other objects' edges named and linked while `drop()` does not.

So budget long-lived contexts: each retained call costs ~200 B, collected
only when the object itself dies. The request-scoped pattern (a fresh
context instance per request — what the mnemonica wiring gives you for
free) never accumulates, because request objects are short-lived by
construction. A service that must be long-lived and is wrapped heavily can
instead pass a fresh lightweight context per operation:

```typescript
// the service lives; the trace context does not accumulate on it
setTimeout(wrap(() => sweep(cache), { sweep: i++ }), 1000);
```

And when you choose to keep a long-lived object but not its whole
history, `edge.drop(obj)` removes that object from its trace — edges and
links stay, the object is unnamed and unanchored. `edge.drop()` wipes the
whole trace and makes it collectable on the next GC round — at a stated
price: Errors pinned into
a wiped trace keep only their own edge, so wipe after the crash handlers
ran, never before.

Reproduce the numbers yourself from the repository:

```bash
npm test -- test/long-lived-chain.spec.ts   # the npm script supplies --expose-gc
```

---

## How to check what holds memory

Running traces are observable — walk from the counters to the anchor:

1. **`stats.alive` vs `stats.running`.** If `alive` grows at rest while
   `running` is 0, finished chains are being pinned somewhere.
2. **`chainDepth(obj)` on your suspects.** A depth that grows with every
   call on one object names the accumulator (see the section above).
3. **`getFlow(obj)`** walks the linked list newest → root: each edge shows
   `kind`, `name`, and the instance it happened to — you see exactly which
   object anchors the chain and which calls built it.
4. Choose at the anchor — this retention is by design, and the choice is
   yours: keep the story (a long-lived object's history is often exactly
   what you want), give the long-lived work a fresh per-operation context
   (the pattern above), or evict explicitly once you know what you are
   holding — `edge.drop(obj)` removes one object from the trace (edges
   stay, links stay); `edge.drop()` wipes the whole trace and makes it
   collectable on the next GC round. Remember the wipe's price: Errors
   pinned into a wiped trace keep only their own edge, so wipe after your
   crash handlers have run, not before.

`stats.collected*` counters lag a GC by one task: force GC, yield one
macrotask, then read.

---

## Framework Integration

For NestJS there is a dedicated adapter:
[`@mnemonica/nestjs`](https://www.npmjs.com/package/@mnemonica/nestjs) —
module system, validation pipe, interceptors, and `attachHooks()` (the dive ↔
mnemonica lifecycle wiring). `MnemonicaModule.forRoot({ thunderstruck: true })`
activates the whole bundle.

Outside NestJS, call `attachHooks(collection)` from `@mnemonica/otel` once at
startup, and every mnemonica instance created while serving a request becomes
context automatically (the instance **is** the context). At decoupled
boundaries (queues, timers, emitters), `wrap()` the callback with the
instance it processes — the failure will then carry the data and the flow.
For anything else, the integration primitives (`enterContext`,
`wrapConstructorArg`, `upgradeConstructorArg`, `wrapInstanceMethods`,
`recordCreation`, `recordCreationError`) let you wire dive into your own
lifecycle events — the full wiring source ships in
[`@mnemonica/otel`](https://www.npmjs.com/package/@mnemonica/otel) as
`attachHooks`.

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
| Memory overhead | One store per async resource | Object-linked edges — GC reachability is the bound |

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

- **Loses intent**: Is a wrapped callback intentional context propagation, or
  an accidental side effect of aggressive instrumentation?
- **Creates noise**: In a heavily async system (event-driven I/O, streams,
  timers), 90% of execution flow is plumbing, not business logic.
- **Breaks isolation**: Wrapping `setTimeout` globally can interfere with
  libraries that rely on precise callback timing or unwrapped behavior.
- **Hides bugs**: If EVERY function is wrapped, errors become attributed to
  dive's internals rather than the user's actual code path.

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

Note that wrapping the generator *function* itself does not help: the wrapped
call returns the iterator object, the edge closes `'ok'` at that moment, and
the body still runs later through unwrapped `next()` calls. `wrap()` traces
iterator creation, not the body — the resumptions are the unit of work, so
they are what you wrap.

The deeper reason this stays manual: `yield` is a "stop the world on the
stack" pattern — it suspends the frame itself, where `async`/`await` is a
simple continuation the promise tap can outlive. Intercepting `next()` would
mean dive owns the iterator protocol's pacing — computability bought at the
expense of debuggability. Reframe the usage instead: collect the steps,
`await` them, or wrap each resumption explicitly.

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
   `@mnemonica/otel` providers emit OpenTelemetry spans carrying
   `dive.instance.uuid` (the NestJS adapter wires them in), so Jaeger
   stitches what dive cannot see.

Where dive differs from ALS is *which* in-process boundary it pins to. ALS
binds context to the async **resource** chain — ambient, correct only while
every library propagates perfectly, and already gone when `uncaughtException`
fires. Dive pins to the **object graph** — which is why attribution survives
process-level escapes and arbitrary queue reordering.

### The CJS/ESM instance split

The package dual-builds: `import` resolves to `build/` (ESM), `require` to
`build-cjs/` (CJS). Dive's trace state is module-level, so the two flavors
are **separate instances in the same process**: edges recorded through the
ESM entry are invisible to a `require('@mnemonica/dive')` reader, and vice
versa. As a user, just know that if your code mixes both entry styles (rare,
but e.g. an ESM app inspected by a `createRequire`-based tool), the two
sides see different traces. Pick one entry style per process and stay with it.

---

## Repository Layout

The published package is `build/` + `build-cjs/` + this README + LICENSE.
For maintainers — internals, invariants, and how to work on dive itself —
see `AGENTS.md` in the repository.

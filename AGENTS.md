# AGENTS.md — @mnemonica/dive

Guidance for AI agents modifying this package. If you are *using* dive in
your own project, start with [`README.md`](./README.md) — this file is for
coding dive itself.

[`SKILL.md`](./SKILL.md) is the wiring guide: where wraps must be placed
(entry points, detach points), the context rule, and the probed limits.

## What this is

Execution-flow tracing for the mnemonica stack: context is pinned to
instances, errors carry their data, and the trace is object-linked — edges
hold their parents directly and live exactly as long as something alive
keeps them (create/call edges, status, duration, parentage).

Charter-level constraints (settled — do not re-litigate):

- **Dive imports nothing.** No `async_hooks`, not even via an injected
  probe. Escape detection via `init` hooks was designed, rejected, and
  retired: a diagnostic that requires process-wide hook registration
  violates the charter no matter where it is placed. The edge lifecycle
  hooks are the escape hatch — a subscriber sees an escaped callback as a
  missing continuation.
- **Dive is a singleton.** Multi-instance (`createDive`) was designed and
  parked: no evidence of two real tenants needing isolated traces in one
  process. Revisit only with that evidence.
- **Emission, never ingestion.** Dive publishes enter/leave/settle/
  recontext/create; subscribers (OTel vendors, monitoring layers) correlate
  from THEIR side at the one moment both trees share a frame. Subscriber
  exceptions are contained per-subscriber.
- **Opt-in model.** Dive wraps only what userland explicitly wrapped. The
  README's "Intentionally Not Covered" is the contract; do not add
  auto-wrapping of timers, emitters, streams, or `next()`.

## The settled facts (invariants — pin these with tests when touching them)

- **Retention is object-linked.** No edge container, no size limit, no
  retention knobs. `parents: WeakMap<Edge, Edge>`, `latestEdges:
  WeakMap<instance, Edge>`, `runningEdges: Set<Edge>`, cursor, plus two
  FinalizationRegistries feeding `stats`. GC reachability IS the memory
  bound. A flow nothing references is gone.
- **Instance references are weak, always.** `edge.instance` is a WeakRef
  deref behind a getter; there is no strong mode. Every recorded instance
  is registered with a FinalizationRegistry (`stats.collectedInstances`).
  `stats` (running/recorded/collectedEdges/alive/collectedInstances) is
  always on — measured at 11–16 B per registration, ~3–4% of a fiber. The
  registries are what proved the object-linked redesign; they stay.
- **`'running'` means genuinely unsettled.** The promise tap closes the
  edge (`'ok'` + full-lifetime `duration`) when the whole chain settles,
  not when the sync head returns. Promise-in-promise needs no re-tap: the
  runtime flattens thenables before any `.then` fires (a recursive re-tap
  branch is spec-guaranteed dead code).
- **Construction edges are born settled.** `recordCreation` fires at
  postCreation — the construction HAS completed — so the edge is stamped
  `'ok'`, duration 0, and leaves the running store immediately. `running`
  counts wrapped *calls* in flight, never constructions. Construction
  edges emit the opt-in `create` event, never `enter` (the adapter owns
  that lifecycle via mnemonica hooks; `enter` would double-report).
- **The parentage rule.** Depth > 0: parent is the cursor ("Y called X").
  Depth === 0 (unwrapped boundary): parent is the context instance's latest
  edge — the data's own story, never the possibly-stale cursor. This is
  what makes cross-request clobbering structurally impossible.
- **The `lastContext` residue is current behavior, not a bug.** At rest
  the cursor is `null` (leave restores the previous cursor; `getFlow()`
  with no target is empty at rest). `lastContext` (behind `current()`)
  keeps the newest top-level construction: constructions set it without
  restore, while a wrapped call's leave rolls it back. That instance roots
  its latest edge (`latestEdges`) and, through the parent links, that
  edge's chain. After load + GC, `stats.alive` falls to that chain's depth
  — a fixed, chain-depth-sized residue (~1.7–2.3 KB) that each new
  top-level construction replaces wholesale. Do not "fix" it; document it.
  For crash attribution it is a labelled guess, never evidence.
- **Errors pin once, deepest boundary wins.** Every edge an error passes
  through gets `status: 'error'`, but the error OBJECT is pinned (edge +
  instance symbols) only at the first/deepest wrapped boundary; outer
  re-throws cannot overwrite. The pin is the edge OBJECT, not an id — the
  Error keeps its failing edge alive for as long as the Error lives.
- **Re-wrap is scope shadowing, observable.** `wrap(w)` / same-context is
  idempotent; a DIFFERENT context is honored as shadowing — a `'recontext'`
  handoff edge is recorded, and a fresh wrapper around the ORIGINAL fn is
  returned (wrappers never stack). Auto-wrap crossings never shadow.
- **No stack traces on edges.** The edge tree (name, kind, parentage,
  instance, timing) IS a structured stack; errors carry their own native
  stacks. An opt-in capture flag is the accepted escape hatch if ever
  needed — never always-on.
- **The dual-package split is real.** `require` → `build-cjs/`, `import` →
  `build/`; module-level state means the two flavors are separate instances
  in one process. A `createRequire`-based reader (strategy's cdp-scripts)
  cannot see an ESM target's trace and vice versa — CDP-evaluated code has
  no dynamic-import callback, so the payload path cannot reach the ESM
  instance. Documented in the README as a usage caveat; bridging would
  need a `Symbol.for` global in dive.
- **Crash-time delivery contract.** At `uncaughtException` /
  `unhandledRejection` the crashing fiber's payloads are alive until the
  handler returns — extract and ship synchronously inside the handler; a
  later poller may find payloads collected.
- **`clear()` means reset.** Object links, running store, cursor, depth,
  context, counters, AND all subscribers. Adapter wiring must re-register
  after it.
- **`edge.drop()` is the explicit eviction override.** Method ON AN EDGE
  (not a dive export — a global drop would make later uncaughtException
  flows unexplained), walking from that edge up to the root. `drop()`
  wipes: parent links, latestEdges anchors, per-edge instance refs
  (never the shared WeakRef), running-store membership, and the cursor
  when it points into the trace. `drop(o1, o2, …)` is targeted: same
  walk, only those objects' refs and anchors removed; edges and links
  stay. Price of the wipe, documented in README: a pinned Error keeps
  ONLY its own edge. Copies resolve to their live edge through a WEAK
  side-link (`copySource`) — copies must never pin the trace; the
  Edge fast-properties layout must not grow a field (flow-edge-shape).

## Build & test

```bash
npm run build   # tsc → build/ (ESM) + build-cjs/ (CJS, with package.json marker)
npm test        # npm run build (pretest) && vitest run — always a FRESH build
```

`build/` and `build-cjs/` are gitignored; nothing here is committed from them.
The CJS flavor exists for `require()` consumers (jest ≤29): the exports map
routes `require` to `build-cjs/index.js`, ESM stays the default condition.

## Testing rules (learned the hard way)

1. **Tests that execute compiled output must rebuild first.** Some tests
   spawn child processes against `build/` (e.g. `test/uncaught-real.spec.ts`
   → `test/fixtures/uncaught-child.mjs`; `test/timer-uncaught.spec.ts` →
   `test/fixtures/timer-uncaught-child.mjs`). `pretest` runs `tsc` for exactly
   this reason — never run `vitest` bare and trust the result; a stale
   `build/` makes behavior tests pass against yesterday's semantics. This
   exact trap once hid a breaking trace-semantics change locally that CI
   caught.
2. **Behavior changes must break a test.** Pin behavior with snapshot-like
   assertions: deep-equal the full observed shape (edge kinds AND statuses
   AND durations), not just the fields you touched. If you change trace
   semantics and no test fails, the suite has a hole — add the pinning test
   first, then change the code.
3. **Real crash boundaries need a child process.** Vitest intercepts
   uncaught errors; `uncaughtException` / `unhandledRejection` behavior is
   only real in a plain node child (`--expose-gc` when GC assertions are
   involved). Assert on the child's single JSON stdout line. Never add
   probe env-switches to fixtures — do a one-time break-revert in src,
   watch it go red, revert, log both runs under `/code/experiments/`.
4. **GC assertions must flush the FinalizationRegistry.** Force GC, yield
   one macrotask, then read `stats` — the counters lag a GC by one task.
5. **Negative controls prove mechanisms, not just happy paths.** Every
   recovery assertion wants its unwrapped/negative twin (see
   `timer-uncaught.spec.ts`: wrapped survives GC + pins the error; unwrapped
   collects + pins nothing).
6. **Cross-package version bumps re-run the consumer's suite.** A dependency
   range bump (e.g. adapter onto a new dive) is a behavior change for the
   consumer even with zero source edits — old pins can keep tests green
   against the previous major/minor semantics.

## Internals

The store is object-linked (no `async_hooks`, no buffer):

- `parents` — a `WeakMap<Edge, Edge>`: each edge's execution parent. The
  trace is not a container at all — it is the edges' own links. An edge is
  reachable exactly while something alive holds it: its instance, a pinned
  Error, the running store, or its child edge.
- `latestEdges` — a `WeakMap<instance, Edge>` with each instance's most
  recent edge, so construction and method calls continue the instance's own
  story. Weak, so instances are never pinned by this map.
- `runningEdges` — a `Set<Edge>` of genuinely unsettled edges; an edge
  leaves it at settle. This is the `getRunningEdges()` surface.
- `cursor` — the edge executing right now (`null` at rest), plus
  `activeDepth` tracking how deep we are inside wrapped invocations. Depth
  decides parentage. Leave restores the previous cursor, so nothing is
  kept at rest; the documented residue lives in `lastContext`.
- `lastContext` — the "newest-wins" switcher behind `current()`. Deliberately
  NOT used for trace parentage: concurrent flows may clobber the switcher,
  but they cannot corrupt the trace.

Instance references are weak (`edge.instance` is a WeakRef deref), and
two `FinalizationRegistry` instances feed `stats.collectedEdges` /
`stats.collectedInstances`, so release is observable. GC reachability is
the memory bound — a flow that nothing references is gone.

Method wrapping is applied to the instance's immediate **prototype**, using
`this` (the receiver) as the context. For plain classes — where many instances
share one prototype — each method is wrapped ONCE. Mnemonica gives every
instance its own immediate prototype, so for mnemonica instances this is still
per-instance; it is not worse, just not a win.

Context also rides on **error objects** via two non-enumerable symbol
properties (`mnemonica.dive.edge` — the edge OBJECT, `mnemonica.dive.instance`),
pinned once at the deepest wrapped boundary the error passes through — which
is how data and flow survive to `uncaughtException` / `unhandledRejection`
handlers where ALS's ambient store is already gone.

## The async_hooks isomorphism (design rationale)

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
**async resources** — timers, promises, I/O handles the runtime created —
and instruments *everything* from inside the runtime, whether you asked or
not; `AsyncLocalStorage` then tries to filter that noise back down. Dive
parents the graph on **invocations carrying data** — and wraps only what you
explicitly wrapped, from userland. The default is silence; you pay per wrap.

This is also why dive survives the synchronous split
([nodejs/diagnostics#249](https://github.com/nodejs/diagnostics/issues/249))
that breaks async_hooks-based CLS: at a sync boundary no async resource is
created, so there is nothing to hook — but the invocation still happens, and
dive's context lives on the instance, not on the resource.

## The implementation walkthrough

The whole machinery is one file (`src/index.ts`, ~1350 lines, no imports).

### 0. The shape

Module-level mutable state plus functions: `parents`, `latestEdges`,
`runningEdges`, `cursor: Edge | null`, `activeDepth`, `lastContext`, two
FinalizationRegistries, and the `stats` counters.

### 1. The entrypoint

There is no start function. Dive is inert until **a wrapped function is
invoked**. In a mnemonica app the *wiring* entrypoint is
`attachHooks(collection)` (adapter side), which registers mnemonica
lifecycle hooks — but those hooks themselves only call dive primitives. So
the real entrypoint, always, is: **somebody calls a function that `wrap()`
returned.**

### 2. `wrap(fn, context?)` — the heart

Two phases. **Wrap time** (once): capture the context — explicit argument,
or whatever `lastContext` is right then. Already-wrapped functions pass
through untouched.

**Call time** — every invocation of the wrapped function:

1. Save `previousContext` / `previousCursor`; set
   `lastContext = capturedContext`.
2. `recordEdge(...)` creates a `FlowEdge`
   `{id, parentId, instance, name, kind, ts, status:'running'}`, links it
   into `parents` (and `latestEdges` for its instance), adds it to
   `runningEdges`. The parent comes from `executionParent(context)` — step 3.
3. `cursor = edge; activeDepth++` — we are now inside a wrapped invocation.
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

### 3. The parentage rule — `executionParent`

- **`activeDepth > 0`**: we're truly nested inside another wrapped call →
  parent is the `cursor`. "Y called X" is recorded as it happened.
- **`activeDepth === 0`**: we entered from an **unwrapped boundary**
  (setTimeout fired, emitter called, route handler) — the cursor may be a
  stale edge from some *other* request. So the edge parents on the
  **data**: `latestEdges.get(context)` — the context instance's own most
  recent edge. If it is there, it is alive — never a dangling id, so no
  fresh-root fallback exists.

This is the line that makes the queue proof possible: interleaved requests
can clobber `lastContext` and even the cursor, but a fresh edge at a
boundary continues *its instance's* story, never a stranger's.

### 4. The error path — `pinError`

Every edge an error propagates through gets `status = 'error'` — but the
error **object** is pinned only **once** (if the symbol's already there,
return). Deepest boundary wins; outer re-throws can't overwrite the failure
site. Two non-enumerable symbols go onto the error: `mnemonica.dive.edge`
(the failing edge OBJECT — the Error keeps its own edge alive for as long
as the Error lives) and `mnemonica.dive.instance` (the data). That's the
whole trick behind crash attribution: the error *carries* its provenance, so
`uncaughtException` — where ALS's store is long dead — can still recover
everything.

### 5. The read paths

- `current()` — just `lastContext`. Honest but newest-wins; ambiguous under
  concurrency by design.
- `getFlow(target)` — resolve a starting edge (cursor / error's pinned
  edge / instance's latest edge), then walk the `parents` links upward,
  `unshift`ing into an array → the branch, oldest first. The walk reaches
  exactly as far as something alive kept the chain.
- `getErrorInstance(err)` — pinned instance; fallback: the instance of the
  pinned edge.

### 6. How mnemonica instances enter the picture — `attachHooks` (adapter)

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

### 7. End-to-end: one queue-proof request

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
(`stats`, `clear`) is housekeeping.

## Style

Tabs, aligned colons in object literals, return-via-variable (every return
goes through an intermediate const — debugger rule), no `any`.

## How we work on dive

- **No git mutations by agents** — no commit/push/reset; the owner commits
  at publish time. Working trees stay dirty by design.
- **Experiments live in `/code/experiments/<date>-<name>/`** — soak servers,
  load drivers, CDP smoke drivers, break-revert logs, all with a README.
- **The owner publishes.** Version bumps and `npm publish` are not agent
  work.
- **Review happens in the room** (the mnemonica chat bus): post per-piece
  greens with counts and diffs, the reviewer seat verifies, re-opens one
  item at a time. Viktor reviews once at the end.
- **Reports and memory hygiene:** `reports/` files describe current or open
  state only; delete them once fulfilled or superseded (fix links that
  referenced them). This file describes the present — no dated history, no
  "we used to" narrative. Settled rationale lives here as present-tense
  invariants; rejected designs stay recorded only while they prevent
  re-derivation, then go.

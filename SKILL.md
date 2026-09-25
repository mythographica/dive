# SKILL.md — Where to place dive wraps

Guidance for AI agents (and humans) wiring `@mnemonica/dive` into a
codebase: which places must be wrapped, with what context, and where the
trace ends by design. The full API reference is
[`README.md`](./README.md); this file is *where* and *how to think*.

## The mechanism in one paragraph

`wrap(fn, context)` captures the context when you wrap and restores it when
the wrapped function runs, recording one trace edge per invocation. Edges
parent on the **context object**, so all work wrapped with the same object
stitches into one branch — through timers, queues, and any number of async
hops. When a wrapped call fails, the **error object itself carries the
story**: its deepest wrapped boundary pins the data and the branch to it, so
a process-level `uncaughtException` handler — where ALS stores are already
gone — still reads `getFlow(error)` and `getErrorInstance(error)`.
Retention is object-linked: a branch lives exactly as long as something
alive holds it — a pending wrapped timer keeps its request's chain for as
long as the timer is pending, and a held Error keeps its failing branch for
as long as the Error lives. Nothing referenced, nothing retained.

## The context rule (the one that matters most)

**Wrap with a context object if you want the branch.** The context should
be the thing the work is *about* — the mnemonica instance, the request
payload, the session. All work wrapped with the same object lands in one
branch, no matter how the event loop interleaves it.

```typescript
// stitched branch: call:outer → call:inner
const inner = wrap(function inner () { ... }, ctx);
const outer = wrap(function outer () { inner(); }, ctx);

// inner's errors pin fine, but the branch is one edge deep
const lonely = wrap(function inner () { ... });
```

**Always pass the context at entry points — the ambient fallback is
best-effort, never authoritative.** A contextless `wrap(fn)` falls back to
whatever context ran last: a newest-wins switcher moved by every
construction and lifecycle hook. It is truthful only when instrumentation
is complete AND the flow is fully synchronous; concurrency, out-of-band
construction (REPL, eval, a live-coding channel), or a mid-flight
reassignment can all make a contextless edge wear a FOREIGN instance.
Attribution must be true or absent, never guessed — so entry points pass
their context explicitly, and edges record how the instance was attributed
(`instanceSource: 'explicit' | 'ambient'`) so consumers can distrust
ambient attributions.

## Where to wrap

1. **Entry points — usually already covered.** In NestJS the adapter's
   interceptor wraps the request boundary, and `attachHooks` feeds every
   mnemonica construction (`create` edges) automatically — it also
   auto-wraps constructor arguments and instance methods.
   If you use the adapter, the request → construction → handler chain is
   wired with zero userland code.
2. **Detach points — always manual.** A callback handed to *unwrapped*
   territory leaves dive's execution window. Wrap it with the context
   before handing it over:
   - `setTimeout` / `setInterval` / `setImmediate` callbacks
   - event emitter listeners (`emitter.on(...)`)
   - promise continuations returned to callers outside the wrapped region
   - queue/job workers, stream handlers, `process.nextTick` callbacks
3. **Nested work you want in the branch.** A plain inner function still
   *runs* fine — it is simply invisible to the trace. Wrap it (with the
   shared context) if its failures should reconstruct the full branch.

## Where NOT to wrap (design boundaries)

- Dive never monkey-patches globals (`setTimeout`, `Promise`, …): no
  patched globals, no ALS, no hidden interference with unwrapped code.
- Do not wrap hot paths you don't need traced — wrapping is cheap but not
  free, and every edge is a real object that lives until nothing references
  it.

## Reading results

- `getFlow(error)` — the branch that produced the error, oldest edge first;
  `getFlow(instance)` — the instance's own latest branch; `getFlow()` — the
  current cursor's branch (empty at rest).
- `getErrorInstance(error)` — the data pinned at the failure site (the
  deepest wrapped boundary, not an outer re-throw).
- `getRunningEdges()` — the calls genuinely in flight right now; the
  suspect set inside a crash handler. Note: construction edges are recorded
  at completion, so they never appear here.
- `stats` (`running`, `recorded`, `alive`, `collectedEdges`,
  `collectedInstances`) — live counters; the `collected*` pair lags a GC
  by one task (force GC, yield a macrotask, then read).
- `registerHook('enter' | 'leave' | 'settle' | 'recontext' | 'create')` —
  the exporter surface: subscribe and correlate from your side (start an
  OTel span on `enter`, end it on `settle`; the payload carries the live
  edge object — attach your own symbols to it).

## Long-lived objects and memory checks

- Retention is per context object: an object that lives for the whole
  process keeps one chain link (~200 B) per wrapped call made on it, until
  it dies. Short-lived request instances never accumulate. Give long-lived
  services a fresh lightweight context per operation
  (`wrap(fn, { op: i++ })`), not the singleton itself. Measured (100k
  finished calls, forced GC): held object → `alive=100000`, heap 35.8 MB;
  fresh object per call → `alive=0`, heap 15.4 MB; held object then
  `edge.drop(obj)` or `edge.drop()` on the newest edge → `alive=0`,
  `collectedEdges=100000`, heap 19.5 / 15.6 MB, next call starts at depth
  1. Reproduce: `npm test -- test/long-lived-chain.spec.ts`
  (the npm script supplies `--expose-gc`).
- When `stats.alive` grows at rest (`running` is 0), find the anchor:
  `chainDepth(suspect)` grows per call on the accumulator; `getFlow(obj)`
  walks newest → root showing kind/name/instance per edge. Then choose —
  this retention is by design, not a defect: keep the story; or fresh
  per-op context; or `edge.drop(obj)` to remove one object from its trace
  (edges/links stay); or `edge.drop()` to wipe the whole trace
  collectable — which costs pinned Errors their story (they keep only
  their own edge), so wipe after crash handlers, not before.
  Then GC + one macrotask and re-read `stats`.

## Known limitations

- **Re-throw as a new `Error`** starts a new pin: the new error is pinned
  by the wrapped frame it exits, so you keep the outer story but lose the
  innermost edge. The original error keeps its own pin. When you can,
  re-throw the same object or attach `cause`.
- **A callback passed unwrapped into a timer** and throwing there pins
  nothing — dive saw no wrapped frame on that path. The fix is rule 2,
  not a dive change.
- **The CJS/ESM instance split.** The package dual-builds: `import` and
  `require` resolve to separate module instances with separate traces.
  If your process mixes both entry styles (e.g. an ESM app read by a
  `createRequire`-based inspection tool), the two sides see different
  traces. Pick one entry style per process and stay with it.

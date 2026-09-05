# SKILL.md — Where to place dive wraps

Guidance for AI agents (and humans) wiring `@mnemonica/dive` into a
codebase: which places must be wrapped, with what context, and where the
trace ends by design. Read [`DECISIONS.md`](./DECISIONS.md) for *why*;
this file is *where*.

## The mechanism in one paragraph

Dive uses **no AsyncLocalStorage and no async_hooks**. Three plain-data
structures carry the whole trace: `activeDepth`/`cursor` (which wrapped
call is executing right now), `latestEdge` — a `WeakMap` from a context
object to its most recent edge (this is what stitches branches together),
and error pinning — a `WeakMap` keyed on the **error object itself**.
Consequences, verified by probe:

- A throw's pin travels with the error OBJECT across any number of
  microtask/macrotask hops, readable from anywhere (`getFlow(error)`,
  `getErrorInstance(error)`) — a process-level `uncaughtException`
  handler included.
- Branch parentage threads through the **context object** passed to
  `wrap(fn, context)`. It survives `setTimeout` firing after the
  scheduling call returned. A contextless wrap records its edge but does
  NOT stitch into the caller's branch — even inside a live call chain.

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
`lastContext`: a module-global, newest-wins switcher moved by every
construction and lifecycle hook. It is truthful only when instrumentation is
complete AND the flow is fully synchronous; concurrency, out-of-band
construction (REPL, eval, the strategy WS channel), or a mid-flight
reassignment can all make a contextless edge wear a FOREIGN instance.
Attribution must be true or absent, never guessed — so entry points pass
their context explicitly, and edges record how the instance was attributed
(`instanceSource: 'explicit' | 'ambient'`) so consumers can distrust ambient
attributions.

## Where to wrap

1. **Entry points — usually already covered.** In NestJS the adapter's
   interceptor wraps the request boundary, and `attachHooks` feeds every
   mnemonica construction (`create` edges) automatically — it also
   auto-wraps constructor arguments (`wrapConstructorArg` /
   `upgradeConstructorArg`) and instance methods (`wrapInstanceMethods`).
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

- Dive never monkey-patches globals (`setTimeout`, `Promise`, …). That is
  the clinic/bubbleprof approach and it is rejected here: no patched
  globals, no ALS, no hidden interference with unwrapped code.
- Do not wrap hot paths you don't need traced — wrapping is cheap but not
  free, and the ring records every edge.

## Known limitations (probed, not guessed)

- **Re-throw as a new `Error`** starts a new pin: the new error is pinned
  by the wrapped frame it exits, so you keep the outer story but lose the
  innermost edge. The original error keeps its own pin. When you can,
  re-throw the same object or attach `cause`.
- **A callback passed unwrapped into a timer** and throwing there pins
  nothing — dive saw no wrapped frame on that path. The fix is rule 2,
  not a dive change.

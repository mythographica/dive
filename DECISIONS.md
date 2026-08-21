# Design Decisions — @mnemonica/dive

Maintainer-facing log of forks in the road: what was decided, why, and
when to revisit. Recorded so decisions don't get re-litigated. Not
published to npm (the tarball ships only `build/`, `README.md`,
`LICENSE`); user-facing behavior is documented in the README.

---

## 2026-08 — Async edge closure (landed)

**Decision.** `status: 'running'` means *genuinely unsettled*. The promise
tap (`tapPromise`, shared by `wrap()` and `wrapInstanceMethods()`) closes
the edge — `'ok'` + full-lifetime `duration` — when the whole chain
settles, not when the synchronous head returns.

**Why.** Before the fix, every successful async edge kept
`status: 'running'` forever and `duration` covered only the sync head:
`'running'` was ambiguous between "still executing" and "async success
nobody closed out."

**Corner that shaped it.** Promise-in-promise needs no wrapping of its
own: a promise never resolves *to* a promise — the runtime flattens
thenables (assimilation) before any `.then` callback fires, so the tap
outlives any chain and sees only the final value. Rejections at any depth
propagate to the tap's `.catch` for free. A recursive re-tap branch was
considered and dropped as dead code (spec-guaranteed unreachable).

## 2026-08 — `async_hooks` stamping: considered, rejected

**Decision.** Edges are NOT annotated with `executionAsyncId()`; dive
never imports `async_hooks`, not even via an injected probe.

**Why.** The stamp would only reveal what wrap-coverage already explains:
N:1 clusters (many edges, one async resource) are #249 sync-split zones;
1:N (one instance's edges across many resources) is data crossing wrapped
resources — each resumption is its own invocation and edge. An unwrapped
boundary is userland's call (`wrap()` / the pre-root feeding API), not
something a stamp fixes. As a join key to OTel spans, the adapter's
`dive.instance.uuid` span attribute is strictly better: it survives
serialization, while an asyncId doesn't even survive a worker thread —
id counters are per-isolate and collide across workers (verified
experimentally: main and worker both mint id 6). Dive's charter is
"imports nothing"; async_hooks stays out.

**Revisit when.** Someone needs to join dive edges to ALS-based span
timings *inside one process* and the uuid correlation is demonstrably
insufficient. The ready design: an injected `edgeProbe: () => number`
supplied by the adapter (`executionAsyncId` from `node:async_hooks`) —
dive itself still imports nothing.

## 2026-08 — Multi-instance dive (`createDive`): designed, parked

**Decision.** Dive stays a singleton. The adapter exposes the tuning knob
instead: `forRoot({ traceLimit })` / exported `DEFAULT_TRACE_LIMIT`
(`1024`), applied only when explicitly provided so userland
`setTraceLimit()` is never overridden.

**The parked design** (for the day it's needed): one **shared core** —
`edges` ring, id counter, `latestEdge`, cursor, depth, limit — so error
pins and cross-tracer parentage resolve against a single truth and no
per-namespace symbol gymnastics are needed; per-lens state reduces to
`current()` channels and namespace tags on edges. Per-bucket retention
windows were explicitly given up in that design (global FIFO eviction
over a shared insertion-ordered Map); per-bucket memory is served by the
global limit plus payload discipline.

**Revisit when.** There is evidence of two real tenants in one process
needing isolated traces — not before.

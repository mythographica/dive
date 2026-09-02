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
insufficient. NOTE (2026-08, hardened): the injected-probe sketch that
used to live here is withdrawn — no `async_hooks` integration ships
anywhere in the ecosystem, adapter included. The join mechanism is the
edge lifecycle hooks API (0.5.0): subscribers read THEIR OWN store at
enter/settle, the one moment both trees share a frame.

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

## 2026-08 — Evicted continuation points are fresh roots (landed)

**Decision.** When an instance's latest edge was evicted from the ring
buffer, new edges parent to `null` — never to the dangling id.
`executionParent`, `recordCreation`, and `recordCreationError` all
validate `edges.has(own)` before parenting.

**Why.** Before the fix, a new edge could record a `parentId` pointing
at nothing retained: reading was harmless (`getFlow`'s walk stops at the
gap), but the edge CLAIMED to continue a story nobody held. "The story
continues from a forgotten point" and "the story starts here" are now
distinguishable — truncation is visible, not disguised. This matters
more with handoff edges (see the re-wrap entry), where cross-flow links
are the interesting part.

## 2026-08 — Re-wrap with a different context: shadowing, observable (landed)

**Decision.** `wrap()` idempotence narrows to exactly its purpose:
undefined or same context, and internal auto-wrap paths (`wrapArgs`
crossings), return the existing wrapper as-is. An explicit *different*
context is HONORED as shadowing — the callback re-roots onto the new
data story, scoped like module → function. Nothing is silently
suppressed: the re-root is RECORDED as a handoff edge in the trace, so
the context switch is part of the flow graph itself instead of being
either swallowed or alarmed on.

**Why the earlier "silent, defensible" stance was wrong.** Silence was
chosen because the refusal point couldn't distinguish a user mistake
from a legal auto-wrap crossing. The landed design dissolves that:
symbols on the wrapper store the original fn and the captured context
(`SymbolDiveOriginal` / `SymbolDiveContext`), and an internal `auto`
flag marks `wrapArgs`-initiated calls. Mistakes and crossings are then
distinguishable — so explicit intent gets scope-shadowing semantics,
and the handoff edge makes it part of the published trace.
Correct-by-construction AND observable; neither silent nor noisy.

**The landed design** (`wrap` → `wrapEntry` → `wrapInternal`,
`recordHandoff`, `test/recontext.spec.ts`): `wrap(wrapped,
differentContext)` wraps the ORIGINAL fn (never stack wrappers; one edge
per invocation) and records a HANDOFF edge: kind `'recontext'`
(additive FlowKind), `instance` = the new context, `parentId` = the OLD
context's latest RETAINED edge. No per-edge `parentInstance` field —
the graph itself holds the link: later invocations of the new wrapper
parent to the handoff via `latestEdge`, so `getFlow` walks backward
across the re-root into the previous flow. The handoff edge IS the
re-context event for the hooks entry below; one mechanism, not two.
Constructor-arg holders (mutable context by design) carry no origin
symbols and never shadow. Note: whoever already holds the OLD wrapper
keeps the old story — re-rooting affects the returned reference, which
is the honest scope-shadow semantics.

**Revisit when.** A consumer needs the old wrapper invalidated too
(retroactive re-root) — that would be a new, larger decision.
Multiple flows converging on ONE instance merge into that instance's
single linear story via `latestEdge` (the event loop already serialized
reality; the trace doesn't pretend otherwise), with one handoff edge
per incoming flow as the seam. If per-tributary reads are ever wanted
("flow A's contribution apart from flow B's"), add `getFlows(instance)`
(plural): enumerate the seams, walk each. Data already paid for; API
parked until requested.

## 2026-08 — Generators / `yield`: documented, not coded

**Decision.** `wrap()` on a generator function traces iterator creation,
not the body: the call returns an iterator, the edge closes `'ok'`, and
the body runs later through unwrapped `next()` calls (async generators
likewise — the async iterator is not a promise). Dive will NOT intercept
`next()`. The README's Generators section is the contract: wrap each
resumption, or reframe the usage to `await`.

**Why.** `yield` is "stop the world on the stack": it suspends the frame
itself, where `async`/`await` is a plain continuation the promise tap
outlives by spec (assimilation). Supporting it means owning the iterator
protocol's pacing — computability over debuggability, a fox in the
chicken garden. Yields are faster, but their manner is too strong for a
flight recorder whose value is telling the truth simply.

**Revisit when.** A real consumer runs generator-bodied flows that
matter to traces and the resumption-wrapping pattern demonstrably
doesn't serve them.

## 2026-08 — Stack traces per edge: considered, rejected (default)

**Decision.** Edges do not capture JS stack traces. The edge tree —
name, kind, parentage, instance, timing — already IS a structured stack,
semantically richer than raw frames because it shows lineage rather than
call sites; errors additionally carry their own native stacks.

**Why.** `Error.captureStackTrace` on every edge is a hot-path tax for
information redundant ~95% of the time. Frame-debug APIs earn their
keep in frame-based systems (Reatom's atoms are anonymous computations);
dive's context is a named value, so the trace already says *where*.

**Revisit when.** Anonymous/unwrapped plumbing makes edges
undiagnosable in practice. The escape hatch: an opt-in capture flag
(off by default), one nullable field on `FlowEdge` — never always-on.

## 2026-08 — Escape detection via `async_hooks` init hook (REJECTED, retired)

**Decision.** Retired, not parked — the design itself is rejected. No
`async_hooks` integration ships anywhere in the ecosystem: not in dive
("imports nothing"), not in the adapter, not as a dev-only utility. The
constraint is charter-level; a diagnostic that requires process-wide
hook registration violates it no matter where it is placed. This entry
keeps the analysis so the design is never re-derived a third time.

**Why the naive version is dead (verified experimentally).** Peeking
`executionAsyncId()` at wrapped-call entry and exit cannot work: the
execution id is constant within a synchronous run by construction —
probe showed enter 1 / exit 1 while the body scheduled a timer, a
floating promise, and a microtask. The only observation point is the
`init` hook, which fires synchronously at resource creation with
`triggerAsyncId` naming the creating context.

**The rejected design (for the record).** At wrapped-call entry note
`executionAsyncId()`. Dev-mode hook: collect resources whose `init`
fires with `triggerAsyncId` === that entry id ("born inside this
frame"). Every wrapped entry anywhere adds its current
`executionAsyncId()` to a "served" set. A born-resource whose
`before`/`promiseResolve` runs without ever appearing in "served"
escaped unwrapped → warn with the creating edge's name/instance.
Nested escapes (born inside an escaped callback) are unattributed.

**What replaced it.** The edge lifecycle hooks API (0.5.0, below):
dive PUBLISHES enter/leave/settle/recontext, and any subscriber sees an
escaped callback as a missing continuation — no process-wide hook, no
async_hooks import, no new dive code. Escapes remain what the charter
says: the user's instrumentation boundary, documented under
"Intentionally Not Covered". If a real escaped-flow bug ever bites,
the answer is better propagation ergonomics (wrapArgs already chains to
any depth), never scheduler surveillance.

## 2026-08 — Edge lifecycle hooks: emission, not ingestion (landed, 0.5.0)

**Decision (direction).** Dive PUBLISHES its ground truth instead of
consuming foreign context: a `registerHook`-style API (same shape and
philosophy as mnemonica's) fires at the moments bracketing every wrapped
invocation. ALS/OTel vendors subscribe and correlate from THEIR side —
reading `executionAsyncId()` or their store at the one moment both trees
share a frame. Dive never imports async_hooks, never trusts external
propagation, never drinks from the ALS colander.

**Events.** `enter` — right after `recordEdge`, while `cursor` and
`lastContext` hold the truthful values; payload is the fresh edge object
ITSELF (id, parentId, name, kind, instance) plus `args` by reference.
`leave` — sync close in the `finally`, with status/duration and what the
wrap produced (plain value / wrapped function / tapped promise); async
chains get a distinct settle event when the tap closes, so "the sync
head returned" is never confused with "the work is done". Plus the
re-context event from the re-wrap entry above.

**Why.** Zero cost when unsubscribed (one length check per edge);
subscribers pay only for what they read. Enter fires at the only honest
join moment. The adapter's OTel provider — today spanning constructions
only, via mnemonica's hooks — could span EVERY wrapped call with one
subscriber. Subscribers may attach their own symbols to the edge object
(span id), which yields the reverse join for free.

**Containment.** Subscriber exceptions must not corrupt the edge or leak
into user code: dispatch is guarded by try/catch (the enter path
piggybacks on wrap's existing try; the finally/tap paths need their own
guard — still cheap). A throwing subscriber degrades its own
observability, never the trace.

**Revisit when.** Collected: what does publishing mean for us — payload
shape stability as a public contract, and whether hook-observed
correlation retires the escape detector's need for a process-wide hook.
Build order (agreed 2026-08-27): shadowing + handoff edge FIRST, this
API SECOND — when a concrete subscriber exists (OTel spanning every
wrapped call, not just constructions); the escape detector may be
retired by this, maybe never built.

**Landed notes (0.5.0).** `registerHook(event, hook)` with the four events
above, returning an unregister function; overloads narrow the payload type
per event. `enter`/`leave` fire from both wrap paths (`wrapInternal` and
`wrapInstanceMethods`), `settle` from the promise tap, `recontext` from the
handoff. Hooks fire ONLY when an edge is recorded (`traceLimit: 0` → no
events — nothing exists to observe). `clear()` wipes subscribers (reset
means reset); adapter wiring must re-register after it. Construction edges
(`recordCreation`/`recordCreationError`) deliberately emit nothing — that
lifecycle is the adapter's own mnemonica-hook domain, re-publishing it
through dive would double-report. Next: the adapter's OTel provider
subscribes here and spans every wrapped call.
(Landed in @mnemonica/nestjs 0.6.0 as DiveOtelProvider — spans keyed on
edge id, parented on dive's own parentage, async spans end at settle.)

## 2026-08-30 — Opt-in `create` event for construction edges (landed, approved by Viktor)

**Decision.** `registerHook` gains a fifth event, `create`, fired from
`recordCreation`/`recordCreationError` after the edge is finalized (and,
on the error path, after `pinError` — subscribers see the failure pinned).
Payload: `{ edge, error }`, `error` set only on the error path.

**Why a DISTINCT event, not `enter`.** The 0.5.0 silence on construction
edges guarded the ADAPTER from double-reporting: it already owns that
lifecycle via mnemonica's hooks. But a third-party subscriber that is NOT
the adapter (the strategy trace-push channel, landed the same day) cannot
see creation edges otherwise — mnemonica hooks register per-type, there is
no global hook point to attach to from outside. The adapter never
subscribes to `create`, so nothing double-reports; the opt-in keeps the
0.5.0 guarantee intact while opening the channel to non-adapter
observers. Unsubscribed cost stays one length check per edge.

## 2026-09-02 — Weak instance refs landed; ring default unbounded

**Decision.** `setWeakInstanceRefs(true)` stores `edge.instance` as a
WeakRef behind a getter; a FinalizationRegistry reports each collection
(`instanceCollected = true` on the live edges, `getCollectedInstanceCount()`
for observability). The ring default moves from 1024 to
`Number.MAX_SAFE_INTEGER` (Viktor's call) — retention is meant to be
GC-driven, not eviction-driven; `setTraceLimit(1024)` restores the old
bound. Viktor keeps a pre-weak-refs dive on a backup branch for
reproducing experiment 1; the fixture's ring-experiment script
(`tactica-nestjs/scripts/ring-experiment.sh`) reproduces both.

**Evidence** (reports/lastcontext-ambiguity.md, experiments 1 & 2, 60k
requests @ 772→1304 rps): strong+unbounded pins ~6.7KB/request with ZERO
release after load (438.8MB flat across 13 forced GCs); weak+unbounded
released all 60000 instance payloads (collected count matched requests
exactly), ran ~70% faster, floor fell to skeleton metadata only.

**Open tension — RESOLVED same day.** Viktor's call: weak refs are the
DEFAULT (`setWeakInstanceRefs(false)` opts out). The default pair is now
weak + unbounded — GC-driven retention end to end. Semantics note for
consumers: `edge.instance` on an old settled edge may deref to
`undefined`; snapshot payloads at settle/error time if you need them
(main.ts already extracts at handler time).

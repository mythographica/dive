/**
 * @mnemonica/dive — Data + Flow for userland instances.
 *
 * The Goal: uncaughtException / unhandledRejection never know where they came
 * from or WHICH DATA caused them. Dive answers it: context is pinned to
 * userland instances (Data), and every wrapped invocation records an edge in
 * the object-linked flow graph (Flow). When the Data Flow fails, the error is
 * pinned to its deepest flow edge — so the error carries both the data and
 * the flow that happened to it. No AsyncLocalStorage, no async_hooks.
 *
 * Dive is framework- and library-agnostic: it imports nothing at all.
 * The mnemonica hook wiring (attachHooks) lives in @mnemonica/otel — dive
 * only exports the primitives that wiring is built from.
 *
 * This file is the public entry: it creates the DEFAULT dive — one `Dive`
 * instance whose methods, bound once, are the free functions below — and
 * re-exports the `Dive` class for apps that want an isolated dive of their
 * own (`new Dive()` — own edges, counters, hooks and context; see dive.ts).
 * The machinery itself lives one domain per file: constants.ts, types.ts,
 * state.ts, store.ts, hooks.ts, callsite.ts, wrap.ts, flow.ts, dive.ts.
 *
 * Public API:
 *   dive.wrap(fn, context?)       → capture context now, restore + record at invocation
 *   dive.wrap(fn, label?)         → same, with a grouping label for tooling
 *   dive.wrap(fn, context, label) → both
 *   dive.current()                → the instance executing right now
 *   dive.getFlow(target?)         → execution branch: Error | instance | current cursor
 *   dive.getRunningEdges()        → the unfinished fibers right now (copies) — crash-time suspects
 *   dive.getErrorInstance(error)  → the data pinned to an error
 *   dive.stats.{running, recorded, alive, collectedEdges, collectedInstances} → getter fields
 *   dive.chainDepth(target?)      → getFlow(target).length without copying
 *   dive.registerHook(event, cb)  → subscribe to edge lifecycle: enter | leave | settle | recontext | create
 *   dive.unregisterHook(ev, cb)   → detach an exact subscriber by reference
 *   dive.clear()                  → reset everything (testing)
 *   new Dive()                    → an isolated dive with this same API
 *
 * Integration primitives (the wiring that uses them is @mnemonica/otel's
 * attachHooks):
 *   dive.enterContext(instance)        → switch the current() context
 *   dive.wrapConstructorArg(fn, ctx)   → wrap a constructor arg, upgradeable context
 *   dive.upgradeConstructorArg(arg, i) → upgrade an unused arg callback to the instance
 *   dive.wrapInstanceMethods(instance) → wrap the instance's prototype methods
 *   dive.recordCreation(name, i, p?)   → 'create' edge under data-flow parentage
 *   dive.recordCreationError(n, e, p?) → failed 'create' edge + error pinning
 *   dive.isWrappedFunction(fn)         → is this function already dive-wrapped?
 *
 * Internals (flow is linked by OBJECTS — see AGENTS.md "Internals";
 * the GC decides how long history lives):
 *   - parents: WeakMap<edge, edge> — successor → predecessor: a live edge
 *     keeps its ancestors; nothing keeps siblings
 *   - cursor: the edge executing right now. NO rest residue: leave restores
 *     the previous cursor (the finally block of runWrappedInvocation, shared
 *     by wrap() and wrapInstanceMethods()) and it is null at the top level
 *     (its declared initial value; edge.drop() also clears it when it points
 *     into the dropped chain) — getFlow() with no target is empty at rest
 *   - activeDepth: how deep we are inside wrapped invocations; depth > 0 means
 *     the cursor is a truthful execution parent, depth === 0 means we entered
 *     from an unwrapped boundary (timer, emitter, route handler) and parentage
 *     must come from the DATA (latestEdges of the context instance)
 *   - latestEdges: WeakMap<instance, edge> — each instance's most recent edge,
 *     so construction and method calls continue the instance's own story
 *   - lastContext: the "newest-wins" switcher behind current(); deliberately
 *     NOT used for flow parentage, so concurrent flows cannot corrupt the
 *     graph. Unlike the cursor it DOES keep a rest residue: constructions
 *     set it without restore (enterContext), a wrapped call's leave rolls
 *     it back (the same finally block as the cursor) — so at rest it
 *     holds the newest top-level construction in the process (any request):
 *     a labelled guess for attribution, never evidence
 */

import { Dive } from './dive.js';

export type {
	FlowKind,
	FlowStatus,
	AnyFn,
	InstanceSource,
	FlowEdge,
	DiveHookEvent,
	DiveEnterPayload,
	DiveLeavePayload,
	DiveSettlePayload,
	DiveRecontextPayload,
	DiveCreatePayload,
	DiveHookPayload,
	DiveStats,
} from './types.js';
export { Dive } from './dive.js';

// The default dive. The bound methods below are the 0.10.x free-function
// surface: one source of truth (the class), zero logic here.
const defaultDive = new Dive();

// The lib's .bind typing cannot see through the overloaded methods (it
// resolves against one signature), so each const is declared with the
// method's own indexed type — the bind result is that same function, bound.
export const wrap: Dive['wrap'] = defaultDive.wrap.bind(defaultDive);
export const registerHook: Dive['registerHook'] = defaultDive.registerHook.bind(defaultDive);
export const unregisterHook: Dive['unregisterHook'] = defaultDive.unregisterHook.bind(defaultDive);
export const enterContext: Dive['enterContext'] = defaultDive.enterContext.bind(defaultDive);
export const isWrappedFunction: Dive['isWrappedFunction'] = defaultDive.isWrappedFunction.bind(defaultDive);
export const wrapConstructorArg: Dive['wrapConstructorArg'] = defaultDive.wrapConstructorArg.bind(defaultDive);
export const upgradeConstructorArg: Dive['upgradeConstructorArg'] = defaultDive.upgradeConstructorArg.bind(defaultDive);
export const wrapInstanceMethods: Dive['wrapInstanceMethods'] = defaultDive.wrapInstanceMethods.bind(defaultDive);
export const recordCreation: Dive['recordCreation'] = defaultDive.recordCreation.bind(defaultDive);
export const recordCreationError: Dive['recordCreationError'] = defaultDive.recordCreationError.bind(defaultDive);
export const current: Dive['current'] = defaultDive.current.bind(defaultDive);
export const getFlow: Dive['getFlow'] = defaultDive.getFlow.bind(defaultDive);
export const chainDepth: Dive['chainDepth'] = defaultDive.chainDepth.bind(defaultDive);
export const getRunningEdges: Dive['getRunningEdges'] = defaultDive.getRunningEdges.bind(defaultDive);
export const getErrorInstance: Dive['getErrorInstance'] = defaultDive.getErrorInstance.bind(defaultDive);
export const clear: Dive['clear'] = defaultDive.clear.bind(defaultDive);

/** the default dive's control surface — getter fields over its counters
 *  (see DiveStats) */
const { stats } = defaultDive;
export { stats };

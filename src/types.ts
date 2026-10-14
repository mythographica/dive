/**
 * The public type surface (plus the module-internal WrappedFn and DiveHook).
 * Runtime values live in constants.ts; this file is types only.
 */

export type FlowKind = 'create' | 'call' | 'construct' | 'method' | 'recontext';
export type FlowStatus = 'running' | 'ok' | 'error';

/**
 * Any wrap()-able callable, parameter-broad form for the internal machinery
 * (the runtime casts when a value of unknown provenance enters a wrap).
 * Module-internal — the public signatures speak AnyFn.
 */
export type WrappedFn = (...args: unknown[]) => unknown;

/**
 * wrap()'s public constraint: ANY callable, typed params included — the
 * caller's parameter types are the caller's business; the wrapper forwards
 * them untouched. (never[] accepts every parameter list, so the generic T
 * keeps the caller's exact signature.)
 */
export type AnyFn = (...args: never[]) => unknown;

/**
 * How an edge's instance was attributed. 'explicit' — the caller passed the
 * context (or it is the method receiver / the constructed instance);
 * 'ambient' — wrap() fell back to lastContext, a newest-wins ambient that is
 * truthful only for fully-instrumented synchronous flows. Consumers
 * (visualization) should distrust 'ambient': attribution must be true or
 * absent, never guessed. Undefined when the edge carries no instance.
 */
export type InstanceSource = 'explicit' | 'ambient';

export interface FlowEdge {
	id       : number;
	parentId : number | null;
	instance : object | undefined;
	name     : string;
	kind     : FlowKind;
	ts       : number;
	duration : number | undefined;
	status   : FlowStatus;
	/** Grouping label from wrap(fn, label); undefined when unlabeled */
	label?          : string;
	/** file:line:col of the wrap() site (plain path, 1-based) — the join key
	 *  into tactica's eds.json probe registry */
	callsite?       : string;
	/** explicit vs ambient attribution — see InstanceSource */
	instanceSource? : InstanceSource;
	/** true once the edge's instance was collected — edge.instance derefs
	 *  to undefined from then on; false while it lives and for edges
	 *  recorded without one. Derived from the same WeakRef, no lag. */
	instanceCollected? : boolean;
	/**
	 * Explicit trace eviction — walk from THIS edge up to the root
	 * (E, parents.get(E), …):
	 *
	 *   drop()         — wipe the whole trace: every edge on the walk loses
	 *                    its parent link, its object anchor (latestEdges),
	 *                    and its instance ref; running edges leave the
	 *                    running store; the cursor is released when it
	 *                    points into the trace. After it getFlow(E) is just
	 *                    [E], nothing roots the rest, and it collects as
	 *                    soon as nothing outside holds it. Price, stated
	 *                    plainly: an Error pinned to any edge of this trace
	 *                    keeps ONLY its own edge — getFlow(error) no longer
	 *                    reaches the story.
	 *   drop(o1, o2,…) — targeted: the same walk, but only removes the given
	 *                    objects — where an edge's instance is oN, that
	 *                    edge's instance ref is cleared; where
	 *                    latestEdges.get(oN) is the edge, that anchor is
	 *                    deleted. Edges, parent links, other objects,
	 *                    siblings, successors all stay. If oN is not what
	 *                    anchors the trace, memory stays held — by design.
	 *
	 * Copies returned by getFlow()/getRunningEdges() resolve to their live
	 * edge (a weak side-link — copies never pin the trace). No return
	 * value; non-object args are ignored; calling twice is a no-op.
	 */
	drop: (...targets: unknown[]) => void;
}

/**
 * Edge lifecycle hooks — dive PUBLISHES its ground truth (emission, never
 * ingestion). ALS/OTel vendors subscribe and correlate from THEIR side at the
 * one moment both trees share a frame; dive never imports async_hooks and
 * never trusts external propagation.
 *
 *   enter     — right after the edge is recorded, while cursor and lastContext
 *               hold the truthful values. Payload: the fresh edge object ITSELF
 *               (subscribers may attach their own symbols to it — span ids give
 *               the reverse join for free) plus the invocation args by reference.
 *   leave     — the sync close, with the edge's final status/duration and what
 *               the wrap produced (plain value / wrapped function / tapped
 *               promise; undefined when the call threw).
 *   settle    — when a tapped promise chain closes. Distinct from leave so
 *               "the sync head returned" is never confused with "the work is
 *               done": result on resolution, error on rejection.
 *   recontext — a re-wrap handoff: the callback changed ownership, payload
 *               links the old context's story to the new one.
 *   create    — OPT-IN, off the default four: a construction edge recorded
 *               via recordCreation/recordCreationError. Deliberately NOT an
 *               'enter' — that lifecycle is the adapter's own mnemonica-hook
 *               domain, and re-publishing it as enter would double-report
 *               there. A distinct event lets a third-party subscriber (one
 *               that is NOT the adapter — e.g. the strategy trace-push
 *               channel) follow constructions without touching the adapter
 *               contract. error is set on the recordCreationError path.
 *
 * Hooks fire with every recorded edge (recording has no off switch).
 * Dispatch cost when unsubscribed is one length
 * check per edge; subscriber exceptions are contained per-subscriber — a
 * throwing hook degrades its own observability, never the trace.
 */
export type DiveHookEvent = 'enter' | 'leave' | 'settle' | 'recontext' | 'create';

export interface DiveEnterPayload {
	edge : FlowEdge;
	args : unknown[];
}

export interface DiveLeavePayload {
	edge   : FlowEdge;
	result : unknown;
}

export interface DiveSettlePayload {
	edge   : FlowEdge;
	result : unknown;
	error  : unknown;
}

export interface DiveRecontextPayload {
	edge            : FlowEdge;
	fn              : AnyFn;
	previousContext : object | undefined;
	context         : object | undefined;
}

export interface DiveCreatePayload {
	edge  : FlowEdge;
	error : unknown;
}

export type DiveHookPayload =
	DiveEnterPayload | DiveLeavePayload | DiveSettlePayload | DiveRecontextPayload | DiveCreatePayload;

export type DiveHook<P> = (payload: P) => void;

/**
 * dive's control surface — getter FIELDS, read-only, per era (clear()
 * resets them). For tests, benchmarks and live probes.
 *   running            — edges running right now (the running store)
 *   recorded           — edges recorded
 *   collectedEdges     — edges the GC has collected (reported by a
 *                        FinalizationRegistry: lags a GC by one task)
 *   alive              — recorded − collectedEdges
 *   collectedInstances — instances the GC has collected
 */
export interface DiveStats {
	readonly running : number;
	readonly recorded : number;
	readonly collectedEdges : number;
	readonly alive : number;
	readonly collectedInstances : number;
}

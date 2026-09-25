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
 * The mnemonica hook wiring (attachHooks) lives in @mnemonica/nestjs — dive
 * only exports the primitives that wiring is built from.
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
 *
 * Integration primitives (for adapter-level wiring, e.g. @mnemonica/nestjs):
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
 *   - cursor: the edge executing right now. Between invocations it still
 *     holds the last executed edge, which keeps that request's chain alive —
 *     the fixed rest residue (see stats.alive)
 *   - activeDepth: how deep we are inside wrapped invocations; depth > 0 means
 *     the cursor is a truthful execution parent, depth === 0 means we entered
 *     from an unwrapped boundary (timer, emitter, route handler) and parentage
 *     must come from the DATA (latestEdges of the context instance)
 *   - latestEdges: WeakMap<instance, edge> — each instance's most recent edge,
 *     so construction and method calls continue the instance's own story
 *   - lastContext: the "newest-wins" switcher behind current(); deliberately
 *     NOT used for flow parentage, so concurrent flows cannot corrupt the
 *     graph. Between constructions it still holds the last constructed
 *     instance — the same fixed rest residue as the cursor
 */

const SymbolDiveInstance = Symbol.for('mnemonica.dive.instance');
const SymbolDiveEdge = Symbol.for('mnemonica.dive.edge');
const SymbolDiveWrapped = Symbol.for('mnemonica.dive.wrapped');
const SymbolDiveArgHolder = Symbol.for('mnemonica.dive.argHolder');
// Origin info installed on every wrap() wrapper: the ORIGINAL fn and the
// captured context. This is what makes re-wrap shadowing possible — a
// wrapper always knows what it wraps and whose story it tells.
const SymbolDiveOriginal = Symbol.for('mnemonica.dive.original');
const SymbolDiveContext = Symbol.for('mnemonica.dive.context');
// Identity of a wrap SITE (not the wrapped fn): the callsite is captured once
// per wrap and the label is the user's optional grouping tag. Together with the
// caption they are the runtime half of the AoT join — tactica's eds.json
// records wrap entries in the same file:line:col format.
const SymbolDiveCallsite = Symbol.for('mnemonica.dive.callsite');
const SymbolDiveLabel = Symbol.for('mnemonica.dive.label');
const SymbolDiveCaption = Symbol.for('mnemonica.dive.caption');

// The domain vocabulary, defined once — a single source of truth for every
// status, kind, and fallback name the trace can carry.
const STATUS_RUNNING = 'running';
const STATUS_OK = 'ok';
const STATUS_ERROR = 'error';
const KIND_CREATE = 'create';
const KIND_CALL = 'call';
const KIND_CONSTRUCT = 'construct';
const KIND_METHOD = 'method';
const KIND_RECONTEXT = 'recontext';
const ANONYMOUS = 'anonymous';
const FN_NAME = 'name';

export type FlowKind = 'create' | 'call' | 'construct' | 'method' | 'recontext';
export type FlowStatus = 'running' | 'ok' | 'error';

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

// A constructor arg wrapped at preCreation carries a MUTABLE context holder so
// postCreation can upgrade an as-yet-unused callback from the parent context to
// the built instance it belongs to. `used` is set the moment it is invoked.
interface DiveArgHolder { context: object | undefined; used: boolean; }

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
	fn              : (...args: unknown[]) => unknown;
	previousContext : object | undefined;
	context         : object | undefined;
}

export interface DiveCreatePayload {
	edge  : FlowEdge;
	error : unknown;
}

export type DiveHookPayload =
	DiveEnterPayload | DiveLeavePayload | DiveSettlePayload | DiveRecontextPayload | DiveCreatePayload;

type DiveHook<P> = (payload: P) => void;

const hooks: Record<DiveHookEvent, Array<DiveHook<DiveHookPayload>>> = {
	enter     : [],
	leave     : [],
	settle    : [],
	recontext : [],
	create    : [],
};

/**
 * Subscribe to an edge lifecycle event. Returns an unregister function.
 * Same shape and philosophy as mnemonica's own registerHook.
 */
export function registerHook (event: 'enter', hook: DiveHook<DiveEnterPayload>): () => void;
export function registerHook (event: 'leave', hook: DiveHook<DiveLeavePayload>): () => void;
export function registerHook (event: 'settle', hook: DiveHook<DiveSettlePayload>): () => void;
export function registerHook (event: 'recontext', hook: DiveHook<DiveRecontextPayload>): () => void;
export function registerHook (event: 'create', hook: DiveHook<DiveCreatePayload>): () => void;
export function registerHook (event: DiveHookEvent, hook: (...args: never[]) => void): () => void {
	const subscribers = hooks[event];
	// The public overloads narrow the payload per event; internally every
	// subscriber is stored against the union and dispatched within its own try.
	const stored = hook as DiveHook<DiveHookPayload>;
	subscribers.push(stored);
	const unregister = (): void => {
		detachHook(event, stored);
	};
	return unregister;
}

function detachHook (event: DiveHookEvent, hook: DiveHook<DiveHookPayload>): void {
	const subscribers = hooks[event];
	const at = subscribers.indexOf(hook);
	if (at !== -1) {
		subscribers.splice(at, 1);
	}
}

/**
 * Detach an exact subscriber by reference — for when the unregister closure
 * returned by registerHook was not kept. No-op for unknown hooks.
 */
export function unregisterHook (event: 'enter', hook: DiveHook<DiveEnterPayload>): void;
export function unregisterHook (event: 'leave', hook: DiveHook<DiveLeavePayload>): void;
export function unregisterHook (event: 'settle', hook: DiveHook<DiveSettlePayload>): void;
export function unregisterHook (event: 'recontext', hook: DiveHook<DiveRecontextPayload>): void;
export function unregisterHook (event: 'create', hook: DiveHook<DiveCreatePayload>): void;
export function unregisterHook (event: DiveHookEvent, hook: (...args: never[]) => void): void {
	const stored = hook as DiveHook<DiveHookPayload>;
	detachHook(event, stored);
}

/**
 * Contained dispatch: every subscriber runs inside its own try, so a throwing
 * hook degrades its own observability and never corrupts the edge, the result,
 * or user code.
 */
function dispatchHook (subscribers: Array<DiveHook<DiveHookPayload>>, payload: DiveHookPayload): void {
	for (const subscriber of subscribers) {
		try {
			subscriber(payload);
		} catch {
			// a throwing subscriber degrades its own observability, never the trace
		}
	}
}

function emitEnter (edge: FlowEdge, args: unknown[]): void {
	const subscribers = hooks.enter;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveEnterPayload = { edge, args };
	dispatchHook(subscribers, payload);
}

function emitLeave (edge: FlowEdge, result: unknown): void {
	const subscribers = hooks.leave;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveLeavePayload = { edge, result };
	dispatchHook(subscribers, payload);
}

function emitSettle (edge: FlowEdge, result: unknown, error: unknown): void {
	const subscribers = hooks.settle;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveSettlePayload = { edge, result, error };
	dispatchHook(subscribers, payload);
}

function emitRecontext (
	edge: FlowEdge,
	fn: (...args: unknown[]) => unknown,
	previousContext: object | undefined,
	context: object | undefined
): void {
	const subscribers = hooks.recontext;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveRecontextPayload = { edge, fn, previousContext, context };
	dispatchHook(subscribers, payload);
}

function emitCreate (edge: FlowEdge, error: unknown): void {
	const subscribers = hooks.create;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveCreatePayload = { edge, error };
	dispatchHook(subscribers, payload);
}


// Flow links are OBJECTS (AGENTS.md "Internals"): the GC can
// see them, so whatever is alive keeps its own chain.
//   latestEdges: object → its latest edge (lives as long as the object;
//                the continuation point for later edges on the same data)
//   parents:     successor edge → predecessor edge (a live edge keeps its
//                ancestors; nothing keeps siblings)
// Edge ids and parentId stay on edges as LABELS only.
let latestEdges = new WeakMap<object, Edge>();
let parents = new WeakMap<Edge, Edge>();
let nextEdgeId = 1;
// The running-edges store (design note: reports/running-edges-store-design.md):
// the edge objects added at recordEdge and deleted at settle — the unfinished
// fibers, i.e. the suspect set for uncaughtException attribution, queryable
// in O(1) without walking parents. This is the
// ONLY strong root dive owns: a running edge = incomplete flow = never
// collectable. Skeletons only: the payload stays behind the edge's WeakRef
// getter, so this set never pins user data. Invalidation is lifecycle-driven
// (settle), never consumer-driven — an unconsumed store leaks nothing.
const runningEdges = new Set<FlowEdge>();
// Copy → the LIVE edge it was copied from, held weakly: copies returned by
// getFlow()/getRunningEdges() resolve back to their live edge for edge.drop()
// and flow walks — without copies pinning the trace (a strong link here
// would keep every copied branch alive for as long as any copy is stored).
const copySource = new WeakMap<Edge, WeakRef<Edge>>();
let cursor: Edge | null = null;
let activeDepth = 0;
let lastContext: object | undefined;

/**
 * Edges never pin their instance (weak refs are the only mode — AGENTS.md
 * "settled facts"): edge.instance is a
 * WeakRef deref, so a finished fiber's payload is GC-releasable.
 * instanceCollected is derived from that same WeakRef (Edge below).
 * ONE WeakRef per instance, shared by all its edges (a Session behind
 * every key press does not get one WeakRef per edge): a new edge takes it
 * from the instance's latest edge (latestEdges, below).
 * The registries only COUNT collections (dive.stats): instances once per
 * instance (first sight: no latest edge yet), edges once per edge. Every
 * registration carries the ERA token current at recording time; clear()
 * starts a new era, so callbacks for pre-clear objects — which keep
 * arriving after it — never touch the new era's counters.
 */
let era: object = {};
let recordedEdgeCount = 0;
let collectedEdgeCount = 0;
let collectedInstanceCount = 0;
const instanceRegistry = new FinalizationRegistry((recordedIn: object) => {
	if (recordedIn === era) {
		collectedInstanceCount++;
	}
});
const edgeRegistry = new FinalizationRegistry((recordedIn: object) => {
	if (recordedIn === era) {
		collectedEdgeCount++;
	}
});

function isObjectKey (value: unknown): value is object {
	return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * The edge object. Every field is declared in the constructor, so all
 * edges share one V8 hidden class (fast properties); `instance` is ONE
 * prototype getter over the private WeakRef — no per-edge closure.
 * A per-edge Object.defineProperty getter plus late instanceCollected
 * lands in V8 dictionary mode: a 448-byte property table
 * per edge (measured in /code/experiments/2026-09-24-otel-soak-unbounded/) —
 * the declaration-order layout above is what keeps an edge at ~120 B.
 */
class Edge implements FlowEdge {
	id             : number;
	parentId       : number | null;
	name           : string;
	kind           : FlowKind;
	ts             : number;
	duration       : number | undefined;
	status         : FlowStatus;
	label          : string | undefined;
	callsite       : string | undefined;
	instanceSource : InstanceSource | undefined;
	#ref           : WeakRef<object> | undefined;

	constructor (id: number, parentId: number | null, name: string, kind: FlowKind, ref: WeakRef<object> | undefined) {
		this.id = id;
		this.parentId = parentId;
		this.name = name;
		this.kind = kind;
		this.ts = Date.now();
		this.duration = undefined;
		this.status = STATUS_RUNNING;
		this.label = undefined;
		this.callsite = undefined;
		this.instanceSource = undefined;
		this.#ref = ref;
	}

	get instance (): object | undefined {
		const result = this.#ref === undefined ? undefined : this.#ref.deref();
		return result;
	}

	/** true once the edge's instance was collected; false while it lives
	 *  and for edges recorded without one */
	get instanceCollected (): boolean {
		const result = this.#ref !== undefined && this.#ref.deref() === undefined;
		return result;
	}

	/** the instance's shared WeakRef — module-internal (the class is not
	 *  exported), so the next edge on the same instance can reuse it */
	static refOf (edge: Edge): WeakRef<object> | undefined {
		const result = edge.#ref;
		return result;
	}

	/**
	 * A snapshot for the public accessors: data fields copied, the SAME
	 * WeakRef shared — reading the copy never pins the instance, and its
	 * collection is visible through the copy. A weak side-link points the
	 * copy at its live original (chained to the first non-copy source, so
	 * a copy of a copy still resolves) — see copySource above.
	 */
	copy (): Edge {
		const result = new Edge(this.id, this.parentId, this.name, this.kind, this.#ref);
		result.ts = this.ts;
		result.duration = this.duration;
		result.status = this.status;
		result.label = this.label;
		result.callsite = this.callsite;
		result.instanceSource = this.instanceSource;
		const source = copySource.get(this);
		copySource.set(result, source ?? new WeakRef(this));
		return result;
	}

	/**
	 * Explicit trace eviction — walk from THIS edge up to the root
	 * (this, parents.get(this), …). See the FlowEdge.drop doc for the
	 * contract; this is the implementation the copies resolve into.
	 */
	drop (...targets: unknown[]): void {
		// copies resolve to their live edge; a dead original is a no-op
		const source = copySource.get(this);
		const start = source ? source.deref() : this;
		if (start === undefined) {
			return;
		}
		if (targets.length === 0) {
			Edge.wipeTrace(start);
			return;
		}
		const wanted = new Set<object>(targets.filter(isObjectKey));
		if (wanted.size === 0) {
			return; // only non-object args — ignored, and NOT a wipe
		}
		let edge: Edge | undefined = start;
		while (edge) {
			const parent = parents.get(edge);
			const inst = edge.#ref === undefined ? undefined : edge.#ref.deref();
			// remove the edge's instance ref when it belongs to a wanted object
			if (inst !== undefined && wanted.has(inst)) {
				edge.#ref = undefined;
			}
			// remove the anchor only when THIS edge is what anchors a wanted object
			for (const t of wanted) {
				if (latestEdges.get(t) === edge) {
					latestEdges.delete(t);
				}
			}
			edge = parent;
		}
	}
	/**
	 * The full-trace half of drop(): every edge from `start` up to the root
	 * loses its parent link, its object anchor, and its instance ref;
	 * running edges leave the running store; the cursor is released when
	 * it points into the trace. The per-edge #ref field is cleared — never
	 * the shared WeakRef object — and the fast-properties layout is
	 * untouched. A private static because only the class may touch #ref.
	 */
	private static wipeTrace (start: Edge): void {
		let edge: Edge | undefined = start;
		while (edge) {
			const parent = parents.get(edge);
			parents.delete(edge);
			const inst = edge.#ref === undefined ? undefined : edge.#ref.deref();
			if (inst !== undefined && latestEdges.get(inst) === edge) {
				latestEdges.delete(inst);
			}
			edge.#ref = undefined;
			runningEdges.delete(edge);
			if (cursor === edge) {
				cursor = null;
			}
			edge = parent;
		}
	}
}

/**
 * A settled edge leaves the running store. Called exactly where status
 * transitions out of 'running' (pinError's error mark, tapPromise's
 * resolve, the sync-return sites, recordCreation) so the store stays a
 * faithful index of status === 'running'.
 */
function settleRunning (edge: FlowEdge): void {
	runningEdges.delete(edge);
}

/**
 * Record an edge — always (recording has no off switch). The edge joins
 * the object graph: parents (its predecessor), latestEdges (its instance's
 * continuation point), runningEdges (until it settles). The registries
 * only COUNT it.
 */
function recordEdge (
	kind: FlowKind,
	name: string,
	instance: object | undefined,
	parent: Edge | null
): Edge {
	let ref: WeakRef<object> | undefined;
	if (isObjectKey(instance)) {
		const latest = latestEdges.get(instance);
		ref = latest ? Edge.refOf(latest) : undefined;
		if (ref === undefined) {
			ref = new WeakRef(instance);
			instanceRegistry.register(instance, era);
		}
	}
	const edge = new Edge(nextEdgeId++, parent ? parent.id : null, name, kind, ref);
	if (parent) {
		parents.set(edge, parent);
	}
	recordedEdgeCount++;
	edgeRegistry.register(edge, era);
	runningEdges.add(edge);
	if (isObjectKey(instance)) {
		latestEdges.set(instance, edge);
	}
	return edge;
}

/**
 * Parentage rule — the heart of the redesign.
 *
 * Depth > 0: we are truly nested inside another wrapped invocation, so the
 * cursor IS the execution parent ("Y called X" is recorded truthfully).
 *
 * Depth === 0: we entered from an unwrapped boundary (timer, emitter, route
 * handler). The cursor may hold a stale edge from an unrelated flow — trusting
 * it would merge two requests into one branch. Instead the edge continues the
 * DATA's own story: the latest edge of the context instance. This is what
 * makes cross-request trace clobbering structurally impossible.
 * The continuation point is an OBJECT held by latestEdges: if it is there,
 * it is alive — never a dangling id, so no fresh-root fallback is needed.
 */
function executionParent (context: object | undefined): Edge | null {
	if (activeDepth > 0 && cursor !== null) {
		return cursor;
	}
	if (isObjectKey(context)) {
		const result = latestEdges.get(context) ?? null;
		return result;
	}
	return null;
}

/**
 * Pin an error to its trace edge and instance. Every edge the error propagates
 * through is marked 'error', but the error OBJECT is pinned only ONCE: the
 * first (deepest) wrapped boundary wins, so the flight recorder points at the
 * failure site, not at some outer re-throw.
 * The pin is the edge OBJECT (not its id): the Error itself keeps its
 * failing edge alive for as long as the Error lives — an exception filter
 * reading getFlow(error) later never depends on anything else still
 * holding the edge.
 */
function pinError (error: unknown, edge: FlowEdge, instance: object | undefined): void {
	if (!isObjectKey(error)) {
		return;
	}
	edge.status = STATUS_ERROR;
	settleRunning(edge);
	if (SymbolDiveEdge in (error as Record<symbol, unknown>)) {
		return;
	}
	Object.defineProperty(error, SymbolDiveEdge, {
		value        : edge,
		writable     : false,
		enumerable   : false,
		configurable : true,
	});
	if (isObjectKey(instance)) {
		Object.defineProperty(error, SymbolDiveInstance, {
			value        : instance,
			writable     : false,
			enumerable   : false,
			configurable : true,
		});
	}
}

/**
 * Switch the "newest-wins" context behind current(). Integration primitive:
 * adapter-level wiring calls it when a lifecycle event enters an instance's
 * context (e.g. preCreation enters the parent, postCreation the instance).
 * Deliberately NOT used for trace parentage — concurrent flows cannot
 * corrupt the trace through it.
 */
export function enterContext (instance: object | undefined): void {
	lastContext = instance;
}

/**
 * Check if a function is already dive-wrapped. Integration primitive:
 * adapter-level wiring uses it to avoid double-wrapping constructor args.
 */
export function isWrappedFunction (value: unknown): boolean {
	return typeof value === 'function' && SymbolDiveWrapped in (value as unknown as Record<symbol, unknown>);
}

// V8 stack frame tail: "    at fn (file:line:col)" or "    at file:line:col"
const CALLSITE_FRAME = /\(?((?:file:\/\/)?[^()\s]+):(\d+):(\d+)\)?\s*$/;

/**
 * This module's own file as a plain path — used to skip dive-internal frames
 * when capturing a wrap callsite. The package dual-builds (ESM + CJS) and
 * import.meta.url does not exist under CommonJS, so the path comes from this
 * module's own stack frame instead: the first frame of an Error created here
 * IS this file (ESM: "at file:///…/build/index.js:…", CJS: "at
 * Object.<anonymous> (/…/build-cjs/index.js:…)").
 */
function computeSelfPath (): string {
	const stack = new Error().stack ?? '';
	const lines = stack.split('\n');
	for (const line of lines) {
		const match = line.match(CALLSITE_FRAME);
		if (match) {
			const selfPath = match[1].replace(/^file:\/\//, '');
			return selfPath;
		}
	}
	// No parseable frame: degrade to "skip nothing" rather than break wrap().
	const selfPath = '';
	return selfPath;
}
const SELF_PATH = computeSelfPath();

// Frames may arrive SOURCE-MAPPED (node --enable-source-maps): they then
// point at dive's own src/*.ts, not the shipped build output, and an exact
// SELF_PATH match misses them — dive's internal wrap frame leaks as the
// callsite. Skip dive's own src/ and own build-flavor tree (NOT the whole
// package root: in-repo test fixtures live under it, consumers never do).
const SELF_DIRS = [
	SELF_PATH.replace(/\/index\.js$/, '/'),
	SELF_PATH.replace(/\/build(-cjs)?\/index\.js$/, '/src/'),
];

/**
 * Capture the first USERLAND stack frame at wrap time — once per wrap, never
 * per invocation. Normalised to a plain `file:line:col` path, the same format
 * tactica writes into eds.json locations, so a runtime edge joins the AoT
 * probe registry by exact string match.
 */
function captureCallsite (): string | undefined {
	const probe = new Error();
	const { stack } = probe;
	if (!stack) {
		return undefined;
	}
	const frames = stack.split('\n').slice(1);
	for (const frame of frames) {
		const match = frame.match(CALLSITE_FRAME);
		if (!match) {
			continue;
		}
		const file = match[1].replace(/^file:\/\//, '');
		if (file.startsWith('node:')) {
			continue;
		}
		if (file === SELF_PATH || SELF_DIRS.some((dir) => file.startsWith(dir))) {
			continue;
		}
		const result = `${file}:${match[2]}:${match[3]}`;
		return result;
	}
	return undefined;
}

/**
 * Bulb caption cascade:
 *   label + named fn     → `label:name`  (one label groups many names)
 *   label + anonymous fn → callsite      (a bare label cannot tell anonymous
 *                          wraps apart; the label survives on edge.label)
 *   no label             → fn.name, falling back to callsite, then 'anonymous'
 */
function computeCaption (
	fn: (...args: unknown[]) => unknown,
	label: string | undefined,
	callsite: string | undefined
): string {
	const name = (fn as { name?: string }).name;
	if (label !== undefined) {
		if (name) {
			return `${label}:${name}`;
		}
		const result = callsite || ANONYMOUS;
		return result;
	}
	const result = name || callsite || ANONYMOUS;
	return result;
}

/**
 * Tap a promise result so the edge tells the truth about the async work:
 *
 *   - the edge closes ('ok' + full-lifetime duration) when the WHOLE chain
 *     settles. A promise never resolves TO a promise: the runtime flattens
 *     thenables before any .then callback fires (assimilation), so this tap
 *     always sees the final value — a promise returning a promise needs no
 *     wrapping of its own, the tap simply outlives the whole chain;
 *   - a function resolved at the end is wrapped, so context propagates
 *     forward to its future invocations;
 *   - a rejection at ANY depth of the chain propagates here and pins the
 *     error to this edge (deepest-pin wins, see pinError).
 */
function tapPromise (
	result: Promise<unknown>,
	edge: FlowEdge,
	context: object | undefined,
	started: number
): Promise<unknown> {
	const promiseResult = result.then((resolved: unknown) => {
		edge.status = STATUS_OK;
		settleRunning(edge);
		edge.duration = Date.now() - started;
		let settled: unknown = resolved;
		if (typeof resolved === 'function' && !isWrappedFunction(resolved)) {
			const wrappedResult = wrapEntry(resolved as (...args: unknown[]) => unknown, context, true);
			settled = wrappedResult;
		}
		emitSettle(edge, settled, undefined);
		return settled;
	}).catch((error: unknown) => {
		pinError(error, edge, context);
		emitSettle(edge, undefined, error);
		throw error;
	});
	return promiseResult;
}

/**
 * Wrap a function so it restores dive context on invocation AND records the
 * invocation as a trace edge. If no context is provided, captures the current
 * context at wrap time.
 *
 * Re-wrap policy (scope shadowing):
 *   - wrap of an unwrapped fn            → new wrapper, captured context
 *   - wrap of a wrapper, no/same context → idempotent: returned as-is
 *   - wrap of a wrapper, DIFFERENT context → the callback changes ownership:
 *     a 'recontext' handoff edge links the old story to the new one, and a
 *     fresh wrapper around the ORIGINAL fn is bound to the new context
 * Auto-wrap crossings (function args at every wrapped call) never shadow —
 * they are idempotent by design.
 *
 * Handles:
 *   - `new` calls via Reflect.construct (kind: 'construct')
 *   - Returned functions are wrapped to propagate context
 *   - Promise results are tapped (see tapPromise): the edge closes when the
 *     whole chain settles, resolved functions are wrapped, rejections pin
 *     the error to the call's edge
 */
export function wrap<T extends (...args: unknown[]) => unknown> (
	fn: T,
	label?: string
): T;
export function wrap<T extends (...args: unknown[]) => unknown> (
	fn: T,
	context?: object,
	label?: string
): T;
export function wrap<T extends (...args: unknown[]) => unknown> (
	fn: T,
	contextOrLabel?: object | string,
	label?: string
): T {
	const context = typeof contextOrLabel === 'string' ? undefined : contextOrLabel;
	const effectiveLabel = typeof contextOrLabel === 'string' ? contextOrLabel : label;
	const result = wrapEntry(fn, context, false, effectiveLabel);
	return result;
}

/**
 * Idempotence and shadowing policy behind wrap(). `auto` marks internal
 * crossings (wrapArgs at every wrapped call, constructor-arg invocation
 * reads): those are idempotent only, so a callback that already crossed one
 * flow keeps its story when crossing another — re-rooting is the user's
 * explicit act, never a side effect of passing a function around.
 */
function wrapEntry<T extends (...args: unknown[]) => unknown> (
	fn: T,
	context: object | undefined,
	auto: boolean,
	label?: string
): T {
	if (!isWrappedFunction(fn)) {
		const result = wrapInternal(fn, context, label);
		return result;
	}

	if (auto) {
		return fn;
	}

	const existing = (fn as unknown as Record<symbol, unknown>)[SymbolDiveContext] as object | undefined;

	// Explicit wrap with no context or the SAME context: idempotent.
	if (context === undefined || context === existing) {
		return fn;
	}

	// Wrappers without origin info (constructor-arg holders, whose context
	// is a mutable holder by design) cannot be re-rooted this way.
	const original = (fn as unknown as Record<symbol, unknown>)[SymbolDiveOriginal] as T | undefined;
	if (original === undefined) {
		return fn;
	}

	const rec = fn as unknown as Record<symbol, unknown>;
	const caption = rec[SymbolDiveCaption] as string | undefined;
	recordHandoff(original, existing, context, caption);
	// The re-root preserves the ORIGINAL site's label/callsite: a bulb's
	// identity is where it was first wrapped, not where it was re-rooted.
	const result = wrapInternal(
		original,
		context,
		label ?? rec[SymbolDiveLabel] as string | undefined,
		rec[SymbolDiveCallsite] as string | undefined
	);
	return result;
}

/**
 * Record the ownership transfer of a re-rooted callback: a 'recontext'
 * edge on the NEW context, parented on the OLD context's latest retained
 * edge. Later invocations of the new wrapper continue from this edge via
 * latestEdge, so getFlow walks backward across the re-root into the
 * previous flow.
 */
function recordHandoff (
	fn: (...args: unknown[]) => unknown,
	previousContext: object | undefined,
	context: object | undefined,
	caption?: string
): void {
	const parent = isObjectKey(previousContext) ? latestEdges.get(previousContext) ?? null : null;
	const name = caption || (fn as { name?: string }).name || ANONYMOUS;
	const edge = recordEdge(KIND_RECONTEXT, name, context, parent);
	// The context arrives as an argument — attribution is never ambient here
	if (isObjectKey(context)) {
		edge.instanceSource = 'explicit';
	}
	emitRecontext(edge, fn, previousContext, context);
}

/**
 * The actual wrapper construction behind wrapEntry: capture the context,
 * record each invocation as an edge, propagate context through args,
 * returned functions and promise chains, pin errors to the edge.
 */
function wrapInternal<T extends (...args: unknown[]) => unknown> (
	fn: T,
	context: object | undefined,
	label?: string,
	callsiteOverride?: string
): T {
	const capturedContext = context ?? lastContext;
	// Provenance, decided at wrap time: an explicitly passed context is trusted;
	// the lastContext fallback is newest-wins ambient — truthful only for
	// fully-instrumented synchronous flows (see reports/lastcontext-ambiguity.md)
	const capturedSource: InstanceSource = context !== undefined ? 'explicit' : 'ambient';
	const callsite = callsiteOverride ?? captureCallsite();
	const caption = computeCaption(fn, label, callsite);

	const wrapped = function (this: unknown, ...args: unknown[]) {
		const isConstructor = new.target !== undefined;
		const previousContext = lastContext;
		const previousCursor = cursor;
		lastContext = capturedContext;

		const edge = recordEdge(
			isConstructor ? KIND_CONSTRUCT : KIND_CALL,
			caption,
			capturedContext,
			executionParent(capturedContext)
		);
		if (label !== undefined) {
			edge.label = label;
		}
		if (callsite !== undefined) {
			edge.callsite = callsite;
		}
		if (capturedContext !== undefined) {
			edge.instanceSource = capturedSource;
		}
		cursor = edge;
		emitEnter(edge, args);
		activeDepth++;

		const started = edge.ts;
		let produced: unknown;
		try {
			// Wrap function args with the captured context so context propagates
			// DOWN through nested callbacks (args of args). Because each wrapped
			// arg is itself a wrapped function that does this too, the propagation
			// chains to any depth. Already-wrapped args are left as-is.
			const wrappedArgs = wrapArgs(args, capturedContext);

			let result: unknown;
			if (isConstructor) {
				result = Reflect.construct(
					fn as unknown as new (...args: unknown[]) => unknown,
					wrappedArgs,
					new.target
				);
			} else {
				result = fn.apply(this, wrappedArgs);
			}

			// Wrap returned functions so they carry the context forward
			if (typeof result === 'function' && !isWrappedFunction(result)) {
				result = wrapEntry(result as (...args: unknown[]) => unknown, capturedContext, true);
			}

			// If Promise: tap it — the edge closes ('ok' + full-lifetime
			// duration) when the whole chain settles; resolved functions are
			// wrapped to carry context forward; rejections pin to this edge.
			if (result instanceof Promise) {
				const promiseResult = tapPromise(result, edge, capturedContext, started);
				produced = promiseResult;
				return promiseResult;
			}

			edge.status = STATUS_OK;
			settleRunning(edge);
			produced = result;
			return result;
		} catch (error: unknown) {
			pinError(error, edge, capturedContext);
			throw error;
		} finally {
			edge.duration = Date.now() - started;
			emitLeave(edge, produced);
			cursor = previousCursor;
			activeDepth--;
			lastContext = previousContext;
		}
	} as T;

	// Preserve prototype for constructor wrapping
	Object.setPrototypeOf(wrapped, fn);
	wrapped.prototype = fn.prototype;

	Object.defineProperty(wrapped, FN_NAME, {
		value        : `diveWrapped:${caption}`,
		configurable : true,
	});

	Object.defineProperty(wrapped, SymbolDiveWrapped, {
		value        : true,
		configurable : false,
		enumerable   : false,
	});

	// Origin info for re-wrap shadowing (see wrapEntry).
	Object.defineProperty(wrapped, SymbolDiveOriginal, {
		value        : fn,
		configurable : false,
		enumerable   : false,
	});

	Object.defineProperty(wrapped, SymbolDiveContext, {
		value        : capturedContext,
		configurable : false,
		enumerable   : false,
	});

	// Wrap-site identity for re-root preservation and tooling introspection
	Object.defineProperty(wrapped, SymbolDiveCallsite, {
		value        : callsite,
		configurable : false,
		enumerable   : false,
	});

	Object.defineProperty(wrapped, SymbolDiveLabel, {
		value        : label,
		configurable : false,
		enumerable   : false,
	});

	Object.defineProperty(wrapped, SymbolDiveCaption, {
		value        : caption,
		configurable : false,
		enumerable   : false,
	});

	return wrapped;
}

/**
 * Auto-wrap function arguments in an array. Internal: used by wrap() and by
 * wrapInstanceMethods(); not part of the public API.
 */
function wrapArgs (
	args: unknown[],
	context?: object
): unknown[] {
	return args.map((arg) => {
		if (typeof arg === 'function') {
			const result = wrapEntry(arg as (...args: unknown[]) => unknown, context, true);
			return result;
		}
		return arg;
	});
}

/**
 * Wrap a constructor argument with an UPGRADEABLE context. Integration
 * primitive — the adapter-level wiring calls it from preCreation.
 *
 * At preCreation the built instance does not exist yet, so the callback is bound
 * to the parent (existentInstance) via a mutable holder. If it is never invoked
 * during construction, postCreation upgrades the holder to the built instance
 * (see upgradeConstructorArg) — so a callback stored for later use resolves to
 * the instance it belongs to, not its parent. Once invoked, the context is
 * locked (`used`), and later calls keep whatever it ran with.
 *
 * Delegates the actual call to wrap() so it inherits the trace recording and
 * returned-function / promise propagation, reading the holder's CURRENT context
 * each time.
 */
export function wrapConstructorArg (
	fn: (...args: unknown[]) => unknown,
	context: object | undefined
): (...args: unknown[]) => unknown {
	const holder: DiveArgHolder = {
		context,
		used : false,
	};

	const wrapped = function (this: unknown, ...args: unknown[]) {
		holder.used = true;
		const wrappedCall = wrapEntry(fn, holder.context, true);
		const result = wrappedCall.apply(this, args);
		return result;
	} as (...args: unknown[]) => unknown;

	Object.defineProperty(wrapped, SymbolDiveWrapped, {
		value: true, configurable: false, enumerable: false,
	});
	Object.defineProperty(wrapped, SymbolDiveArgHolder, {
		value: holder, configurable: false, enumerable: false,
	});

	return wrapped;
}

/**
 * Upgrade an as-yet-unused constructor-arg callback to the built instance.
 * Integration primitive — the adapter-level wiring calls it from postCreation.
 * No-op for non-wrapped args, or callbacks already invoked during construction.
 */
export function upgradeConstructorArg (arg: unknown, instance: object): void {
	if (typeof arg !== 'function') {
		return;
	}
	const holder = (arg as unknown as Record<symbol, unknown>)[SymbolDiveArgHolder] as DiveArgHolder | undefined;
	if (holder && !holder.used) {
		holder.context = instance;
	}
}

/**
 * Wrap user-defined methods so they run with the receiving instance as the
 * active dive context AND record each call as a 'method' edge.
 * Integration primitive — the adapter-level wiring calls it from postCreation.
 *
 * Wrapping is applied to the instance's immediate PROTOTYPE (not the instance
 * itself), using `this` (the receiver) as the context. For plain classes —
 * where many instances share one prototype — this wraps each method ONCE
 * instead of once per instance. NOTE: mnemonica gives every instance its own
 * immediate prototype, so for mnemonica instances this is still per-instance
 * (no shared prototype exists to wrap once); it is not worse, just not a win.
 * See README "Internals".
 *
 * Wrapped methods also:
 *   - wrap function arguments to propagate context
 *   - wrap function return values
 *   - pin errors (sync throws and promise rejections) to the call's edge
 */
export function wrapInstanceMethods (instance: object): void {
	const proto = Object.getPrototypeOf(instance);
	if (!proto || proto === Object.prototype) {
		return;
	}

	const descriptors = Object.getOwnPropertyDescriptors(proto);

	for (const [name, descriptor] of Object.entries(descriptors)) {
		if (name === 'constructor') {
			continue;
		}
		if (typeof descriptor.value !== 'function') {
			continue;
		}
		if (isWrappedFunction(descriptor.value)) {
			continue;
		}
		// Only a configurable method can be safely redefined on the prototype.
		if (descriptor.configurable === false) {
			continue;
		}

		const fn = descriptor.value as (...args: unknown[]) => unknown;

		const wrappedMethod = function (this: object, ...args: unknown[]) {
			const context = this;
			const previousContext = lastContext;
			const previousCursor = cursor;
			lastContext = context;

			const edge = recordEdge(KIND_METHOD, name, context, executionParent(context));
			// The receiver IS the context — never ambient
			edge.instanceSource = 'explicit';
			cursor = edge;
			emitEnter(edge, args);
			activeDepth++;

			const started = edge.ts;
			let produced: unknown;
			try {
				const wrappedArgs = wrapArgs(args, context);
				let result = fn.apply(this, wrappedArgs);

				if (typeof result === 'function' && !isWrappedFunction(result)) {
					result = wrapEntry(result as (...args: unknown[]) => unknown, context, true);
				}

				if (result instanceof Promise) {
					const promiseResult = tapPromise(result, edge, context, started);
					produced = promiseResult;
					return promiseResult;
				}

				edge.status = STATUS_OK;
				settleRunning(edge);
				produced = result;
				return result;
			} catch (error: unknown) {
				pinError(error, edge, context);
				throw error;
			} finally {
				edge.duration = Date.now() - started;
				emitLeave(edge, produced);
				cursor = previousCursor;
				activeDepth--;
				lastContext = previousContext;
			}
		};

		// Mark so a shared prototype is not re-wrapped by the next instance.
		Object.defineProperty(wrappedMethod, SymbolDiveWrapped, {
			value        : true,
			configurable : false,
			enumerable   : false,
		});

		Object.defineProperty(proto, name, {
			value        : wrappedMethod,
			writable     : true,
			configurable : true,
			enumerable   : false,
		});
	}
}

/**
 * Record a successful construction as a 'create' edge. Integration primitive —
 * the adapter-level wiring calls it from postCreation.
 *
 * The edge is parented on the DATA-FLOW parent (the parent instance's latest
 * edge), so construction at an unwrapped boundary starts a truthful new branch
 * instead of merging into whatever flow ran last; root types fall back to the
 * execution cursor only when truly nested. Also switches current() to the
 * built instance.
 */
// A construction's parent: the parent instance's latest edge (data flow),
// else — only when truly nested — the execution cursor.
function creationParent (parent: object | undefined): Edge | null {
	if (isObjectKey(parent)) {
		const result = latestEdges.get(parent) ?? null;
		return result;
	}
	const result = activeDepth > 0 ? cursor : null;
	return result;
}

export function recordCreation (name: string, instance: object, parent?: object): void {
	const edge = recordEdge(KIND_CREATE, name || ANONYMOUS, instance, creationParent(parent));
	// recordCreation fires at postCreation: the construction HAS completed.
	// 'running' means genuinely unsettled — a finished construction must not
	// wear it. Duration is unmeasured at this level (the hook moment IS the
	// completion), so 0, mirroring recordCreationError.
	edge.status = STATUS_OK;
	settleRunning(edge);
	edge.duration = 0;
	// The constructed instance arrives as an argument — never ambient
	edge.instanceSource = 'explicit';
	// Opt-in 'create', NOT 'enter': the adapter owns this lifecycle via
	// mnemonica's hooks; enter would double-report there (see the event's
	// doc above).
	emitCreate(edge, undefined);
	enterContext(instance);
}

/**
 * Record a FAILED construction as a 'create' edge (status: 'error') under the
 * surviving parent, and pin the error to it: the failure is recoverable off
 * the error object itself. Integration primitive — the adapter-level wiring
 * calls it from creationError.
 */
export function recordCreationError (name: string, errored: unknown, parent?: object): void {
	if (errored instanceof Error) {
		// Record the FAILED creation as an edge in the parent's branch, then
		// pin the error to it — the flight recorder for "the data flow failed".
		const edge = recordEdge(KIND_CREATE, name || ANONYMOUS, parent, creationParent(parent));
		edge.duration = 0;
		// The surviving parent arrives as an argument — never ambient
		if (isObjectKey(parent)) {
			edge.instanceSource = 'explicit';
		}
		pinError(errored, edge, parent);
		// Emitted after pinError so subscribers see the failure already
		// pinned; same opt-in 'create' event as recordCreation.
		emitCreate(edge, errored);
	}
	if (errored) {
		enterContext(errored as object);
	} else if (parent) {
		enterContext(parent);
	}
}

/**
 * The instance executing right now (the "newest-wins" switcher).
 * For anything beyond single-flow code, prefer getFlow() — the trace holds
 * the truth even when concurrent flows make "current" ambiguous.
 */
export function current (): object | undefined {
	const result = lastContext;
	return result;
}

/**
 * Reconstruct an execution branch from the flow graph, oldest edge first.
 *
 *   getFlow()          → branch of the current cursor (empty at rest)
 *   getFlow(error)     → flight recorder: the branch that produced the error
 *   getFlow(instance)  → the branch of that instance's latest edge
 *
 * Returns copies of the live edge objects. The walk follows parents (object links),
 * so a branch reaches back exactly as far as something alive kept it — a
 * held Error, a pending timer, the context instance itself.
 */
export function getFlow (target?: unknown): FlowEdge[] {
	const branch: FlowEdge[] = [];
	let edge = flowStart(target);
	while (edge) {
		branch.unshift(copyEdge(edge));
		edge = parents.get(edge);
	}
	return branch;
}

/**
 * getFlow(target).length without copying a single edge — for tests and
 * benchmarks asserting how long a chain something keeps alive.
 */
export function chainDepth (target?: unknown): number {
	let depth = 0;
	let edge = flowStart(target);
	while (edge) {
		depth++;
		edge = parents.get(edge);
	}
	return depth;
}

// The edge a flow walk starts from: an edge (a copy resolves to its live
// original — see copySource), the edge pinned to an Error, the current
// cursor, or an object's latest edge.
function flowStart (target: unknown): Edge | undefined {
	if (target instanceof Edge) {
		const source = copySource.get(target);
		const result = source ? source.deref() : target;
		return result === undefined ? undefined : result;
	}
	if (target instanceof Error) {
		const pinned = pinnedEdge(target);
		return pinned;
	}
	let result: Edge | undefined;
	if (target === undefined) {
		result = cursor ?? undefined;
	} else if (isObjectKey(target)) {
		result = latestEdges.get(target);
	}
	return result;
}

// The edge object pinError put on an error (undefined when none).
function pinnedEdge (error: object): Edge | undefined {
	const pinned = (error as Record<symbol, unknown>)[SymbolDiveEdge];
	const result = pinned instanceof Edge ? pinned : undefined;
	return result;
}

/**
 * Copy an edge for the public accessors. The instance lives behind the
 * WeakRef getter — a naive spread would READ it at copy time and pin the
 * instance on the copy (the first weak-refs test run failed exactly this
 * way). Edge.copy() shares the WeakRef instead. Every recorded edge is an
 * Edge; the spread branch only narrows the declared FlowEdge type.
 */
function copyEdge (edge: FlowEdge): FlowEdge {
	const result = edge instanceof Edge ? edge.copy() : { ...edge };
	return result;
}

/**
 * The edges still running right now — the unfinished fibers, i.e. the
 * suspect set for uncaughtException/unhandledRejection attribution,
 * without walking parents. Copies, same semantics as getFlow.
 * See reports/running-edges-store-design.md.
 */
export function getRunningEdges (): FlowEdge[] {
	const result = [...runningEdges.values()].map((edge) => copyEdge(edge));
	return result;
}

/**
 * The data pinned to an error. Prefers the instance pinned at the failure
 * site; falls back to the instance of the error's trace edge.
 */
export function getErrorInstance (error: Error): object | undefined {
	if (!isObjectKey(error)) {
		return undefined;
	}
	const pinned = (error as unknown as Record<symbol, unknown>)[SymbolDiveInstance] as object | undefined;
	if (pinned !== undefined) {
		return pinned;
	}
	const edge = pinnedEdge(error);
	const result = edge ? edge.instance : undefined;
	return result;
}

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
export const stats = Object.freeze({
	get running (): number {
		const result = runningEdges.size;
		return result;
	},
	get recorded (): number {
		const result = recordedEdgeCount;
		return result;
	},
	get collectedEdges (): number {
		const result = collectedEdgeCount;
		return result;
	},
	get alive (): number {
		const result = recordedEdgeCount - collectedEdgeCount;
		return result;
	},
	get collectedInstances (): number {
		const result = collectedInstanceCount;
		return result;
	},
});

/**
 * Reset everything: object links, the running store, cursor, depth, context,
 * counters, and the registered lifecycle hooks. Useful for testing — note
 * that adapter-level subscribers must re-register after a clear().
 */
export function clear (): void {
	latestEdges = new WeakMap<object, Edge>();
	parents = new WeakMap<Edge, Edge>();
	nextEdgeId = 1;
	runningEdges.clear();
	cursor = null;
	activeDepth = 0;
	lastContext = undefined;
	era = {};
	recordedEdgeCount = 0;
	collectedEdgeCount = 0;
	collectedInstanceCount = 0;
	hooks.enter.length = 0;
	hooks.leave.length = 0;
	hooks.settle.length = 0;
	hooks.recontext.length = 0;
	hooks.create.length = 0;
}

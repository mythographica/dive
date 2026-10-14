/**
 * The object-linked store: the Edge class, edge recording, settle bookkeeping
 * and the per-dive clear().
 *
 * Every edge belongs to exactly one dive's state — carried as a declared
 * private field set in the constructor, so all edges keep one V8 hidden
 * class (fast properties — the layout is pinned by
 * test/flow-edge-shape.spec.ts). Edge methods that must reach their dive's
 * stores (copy's weak side-link, drop's trace walk) read the field; the read
 * side compares it for ownership (ownsEdge). An edge can never migrate — it
 * just knows its owner.
 */
import { STATUS_RUNNING } from './constants.js';
import type { DiveState } from './state.js';
import type {
	FlowEdge,
	FlowKind,
	FlowStatus,
	InstanceSource,
} from './types.js';

export function isObjectKey (value: unknown): value is object {
	const result = value !== null && (typeof value === 'object' || typeof value === 'function');
	return result;
}

/**
 * Does this state own the edge? The isolation boundary for the read side: a
 * dive's flow walks only ever start from its OWN edges — an edge (or its
 * copy) handed to another dive's getFlow() does not resolve there, and an
 * Error pinned by one dive is not a flow anchor for another (the pinned
 * instance stays readable everywhere — getErrorInstance is state-free by
 * design: the crash handler must recover the data whichever dive it holds).
 */
export function ownsEdge (state: DiveState, edge: Edge): boolean {
	const result = Edge.stateOf(edge) === state;
	return result;
}

/**
 * The edge object. Every field is declared in the constructor, so all
 * edges share one V8 hidden class (fast properties); `instance` is ONE
 * prototype getter over the private WeakRef — no per-edge closure.
 * A per-edge Object.defineProperty getter plus late instanceCollected
 * lands in V8 dictionary mode — a 448-byte property table per edge;
 * the declaration-order layout above is what keeps an edge at ~120 B.
 */
export class Edge implements FlowEdge {
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
	#state         : DiveState;

	constructor (
		id: number,
		parentId: number | null,
		name: string,
		kind: FlowKind,
		ref: WeakRef<object> | undefined,
		state: DiveState
	) {
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
		this.#state = state;
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
	 *  exported from the package), so the next edge on the same instance can
	 *  reuse it */
	static refOf (edge: Edge): WeakRef<object> | undefined {
		const result = edge.#ref;
		return result;
	}

	/** the dive state that recorded the edge — module-internal; the read
	 *  side's isolation check (ownsEdge) and copy()/drop() go through it */
	static stateOf (edge: Edge): DiveState {
		const result = edge.#state;
		return result;
	}

	/**
	 * A snapshot for the public accessors: data fields copied, the SAME
	 * WeakRef shared — reading the copy never pins the instance, and its
	 * collection is visible through the copy. A weak side-link points the
	 * copy at its live original (chained to the first non-copy source, so
	 * a copy of a copy still resolves) — see copySource in state.ts.
	 */
	copy (): Edge {
		const result = new Edge(this.id, this.parentId, this.name, this.kind, this.#ref, this.#state);
		result.ts = this.ts;
		result.duration = this.duration;
		result.status = this.status;
		result.label = this.label;
		result.callsite = this.callsite;
		result.instanceSource = this.instanceSource;
		const source = this.#state.copySource.get(this);
		this.#state.copySource.set(result, source ?? new WeakRef(this));
		return result;
	}

	/**
	 * Explicit trace eviction — walk from THIS edge up to the root
	 * (this, parents.get(this), …). See the FlowEdge.drop doc for the
	 * contract; this is the implementation the copies resolve into.
	 */
	drop (...targets: unknown[]): void {
		const state = this.#state;
		// copies resolve to their live edge; a dead original is a no-op
		const source = state.copySource.get(this);
		const start = source ? source.deref() : this;
		if (start === undefined) {
			return;
		}
		if (targets.length === 0) {
			Edge.wipeTrace(state, start);
			return;
		}
		const wanted = new Set<object>(targets.filter(isObjectKey));
		if (wanted.size === 0) {
			// only non-object args — ignored, and NOT a wipe
			return;
		}
		let edge: Edge | undefined = start;
		while (edge) {
			const parent = state.parents.get(edge);
			const inst = edge.#ref === undefined ? undefined : edge.#ref.deref();
			// remove the edge's instance ref when it belongs to a wanted object
			if (inst !== undefined && wanted.has(inst)) {
				edge.#ref = undefined;
			}
			// remove the anchor only when THIS edge is what anchors a wanted object
			for (const t of wanted) {
				if (state.latestEdges.get(t) === edge) {
					state.latestEdges.delete(t);
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
	private static wipeTrace (state: DiveState, start: Edge): void {
		let edge: Edge | undefined = start;
		while (edge) {
			const parent = state.parents.get(edge);
			state.parents.delete(edge);
			const inst = edge.#ref === undefined ? undefined : edge.#ref.deref();
			if (inst !== undefined && state.latestEdges.get(inst) === edge) {
				state.latestEdges.delete(inst);
			}
			edge.#ref = undefined;
			state.runningEdges.delete(edge);
			if (state.cursor === edge) {
				state.cursor = null;
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
export function settleRunning (state: DiveState, edge: Edge): void {
	state.runningEdges.delete(edge);
}

/**
 * Record an edge — always (recording has no off switch). The edge joins
 * the object graph: parents (its predecessor), latestEdges (its instance's
 * continuation point), runningEdges (until it settles). The registries
 * only COUNT it.
 *
 * ONE WeakRef per instance, shared by all its edges (a Session behind
 * every key press does not get one WeakRef per edge): a new edge takes it
 * from the instance's latest edge.
 */
export function recordEdge (
	state: DiveState,
	kind: FlowKind,
	name: string,
	instance: object | undefined,
	parent: Edge | null
): Edge {
	let ref: WeakRef<object> | undefined;
	if (isObjectKey(instance)) {
		const latest = state.latestEdges.get(instance);
		ref = latest ? Edge.refOf(latest) : undefined;
		if (ref === undefined) {
			ref = new WeakRef(instance);
			state.instanceRegistry.register(instance, state.era);
		}
	}
	const edge = new Edge(state.nextEdgeId, parent ? parent.id : null, name, kind, ref, state);
	state.nextEdgeId = state.nextEdgeId + 1;
	if (parent) {
		state.parents.set(edge, parent);
	}
	state.recordedEdgeCount = state.recordedEdgeCount + 1;
	state.edgeRegistry.register(edge, state.era);
	state.runningEdges.add(edge);
	if (isObjectKey(instance)) {
		state.latestEdges.set(instance, edge);
	}
	return edge;
}

/**
 * Reset everything: object links, the running store, cursor, depth, context,
 * counters, and the registered lifecycle hooks. Useful for testing — note
 * that adapter-level subscribers must re-register after a clear().
 */
export function clearState (state: DiveState): void {
	state.latestEdges = new WeakMap<object, Edge>();
	state.parents = new WeakMap<Edge, Edge>();
	state.nextEdgeId = 1;
	state.runningEdges.clear();
	state.cursor = null;
	state.activeDepth = 0;
	state.lastContext = undefined;
	state.era = {};
	state.recordedEdgeCount = 0;
	state.collectedEdgeCount = 0;
	state.collectedInstanceCount = 0;
	state.hooks.enter.length = 0;
	state.hooks.leave.length = 0;
	state.hooks.settle.length = 0;
	state.hooks.recontext.length = 0;
	state.hooks.create.length = 0;
}

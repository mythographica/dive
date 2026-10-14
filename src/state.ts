/**
 * The per-dive state — ONE object per Dive instance (the default dive's state
 * lives in index.ts; new Dive() creates its own). The fields the lifecycle
 * REASSIGNS (clear() swaps the WeakMaps, the era and the counters reset) are
 * get/set accessors over closure cells, so domain files both read and
 * reassign them through the one object; the stores that are only mutated in
 * place (runningEdges, copySource, the registries, the hooks lists) are plain
 * readonly fields.
 *
 * Flow links are OBJECTS (AGENTS.md "Internals"): the GC can
 * see them, so whatever is alive keeps its own chain.
 *   latestEdges: object → its latest edge (lives as long as the object;
 *                the continuation point for later edges on the same data)
 *   parents:     successor edge → predecessor edge (a live edge keeps its
 *                ancestors; nothing keeps siblings)
 * Edge ids and parentId stay on edges as LABELS only.
 */
import type { Edge } from './store.js';
import type {
	DiveHook,
	DiveHookEvent,
	DiveHookPayload,
} from './types.js';

export interface DiveState {
	latestEdges : WeakMap<object, Edge>;
	parents : WeakMap<Edge, Edge>;
	// The running-edges store: the edge objects added at recordEdge and
	// deleted at settle — the unfinished fibers, i.e. the suspect set for
	// uncaughtException attribution, queryable
	// in O(1) without walking parents. This is the
	// ONLY strong root dive owns: a running edge = incomplete flow = never
	// collectable. Skeletons only: the payload stays behind the edge's WeakRef
	// getter, so this set never pins user data. Invalidation is lifecycle-driven
	// (settle), never consumer-driven — an unconsumed store leaks nothing.
	readonly runningEdges : Set<Edge>;
	// Copy → the LIVE edge it was copied from, held weakly: copies returned by
	// getFlow()/getRunningEdges() resolve back to their live edge for edge.drop()
	// and flow walks — without copies pinning the trace (a strong link here
	// would keep every copied branch alive for as long as any copy is stored).
	readonly copySource : WeakMap<Edge, WeakRef<Edge>>;
	// The lifecycle subscribers, per event — registerHook/unregisterHook and
	// the emit* dispatchers in hooks.ts operate on these lists.
	readonly hooks : Record<DiveHookEvent, Array<DiveHook<DiveHookPayload>>>;
	// The registries only COUNT collections (dive.stats): instances once per
	// instance (first sight: no latest edge yet), edges once per edge. Every
	// registration carries the ERA token current at recording time; clear()
	// starts a new era, so callbacks for pre-clear objects — which keep
	// arriving after it — never touch the new era's counters.
	readonly instanceRegistry : FinalizationRegistry<object>;
	readonly edgeRegistry : FinalizationRegistry<object>;
	cursor : Edge | null;
	activeDepth : number;
	lastContext : object | undefined;
	era : object;
	nextEdgeId : number;
	recordedEdgeCount : number;
	collectedEdgeCount : number;
	collectedInstanceCount : number;
}

export function createDiveState (): DiveState {
	let latestEdges = new WeakMap<object, Edge>();
	let parents = new WeakMap<Edge, Edge>();
	let cursor: Edge | null = null;
	let activeDepth = 0;
	let lastContext: object | undefined;
	let era: object = {};
	let nextEdgeId = 1;
	let recordedEdgeCount = 0;
	let collectedEdgeCount = 0;
	let collectedInstanceCount = 0;
	const state: DiveState = {
		get latestEdges (): WeakMap<object, Edge> {
			const result = latestEdges;
			return result;
		},
		set latestEdges (value: WeakMap<object, Edge>) {
			latestEdges = value;
		},
		get parents (): WeakMap<Edge, Edge> {
			const result = parents;
			return result;
		},
		set parents (value: WeakMap<Edge, Edge>) {
			parents = value;
		},
		get cursor (): Edge | null {
			const result = cursor;
			return result;
		},
		set cursor (edge: Edge | null) {
			cursor = edge;
		},
		get activeDepth (): number {
			const result = activeDepth;
			return result;
		},
		set activeDepth (depth: number) {
			activeDepth = depth;
		},
		get lastContext (): object | undefined {
			const result = lastContext;
			return result;
		},
		set lastContext (instance: object | undefined) {
			lastContext = instance;
		},
		get era (): object {
			const result = era;
			return result;
		},
		set era (token: object) {
			era = token;
		},
		get nextEdgeId (): number {
			const result = nextEdgeId;
			return result;
		},
		set nextEdgeId (id: number) {
			nextEdgeId = id;
		},
		get recordedEdgeCount (): number {
			const result = recordedEdgeCount;
			return result;
		},
		set recordedEdgeCount (count: number) {
			recordedEdgeCount = count;
		},
		get collectedEdgeCount (): number {
			const result = collectedEdgeCount;
			return result;
		},
		set collectedEdgeCount (count: number) {
			collectedEdgeCount = count;
		},
		get collectedInstanceCount (): number {
			const result = collectedInstanceCount;
			return result;
		},
		set collectedInstanceCount (count: number) {
			collectedInstanceCount = count;
		},
		runningEdges : new Set<Edge>(),
		copySource   : new WeakMap<Edge, WeakRef<Edge>>(),
		hooks        : {
			enter     : [],
			leave     : [],
			settle    : [],
			recontext : [],
			create    : [],
		},
		// The callbacks run long after the factory returned, against whatever
		// era the state is in THEN — reading through the state object is what
		// keeps clear()'s era swap effective.
		instanceRegistry : new FinalizationRegistry((recordedIn: object) => {
			if (recordedIn === state.era) {
				state.collectedInstanceCount = state.collectedInstanceCount + 1;
			}
		}),
		edgeRegistry : new FinalizationRegistry((recordedIn: object) => {
			if (recordedIn === state.era) {
				state.collectedEdgeCount = state.collectedEdgeCount + 1;
			}
		}),
	};
	return state;
}

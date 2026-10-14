/**
 * Creation recording (the adapter's postCreation/creationError primitives)
 * and the read side of the trace: current(), getFlow(), chainDepth(),
 * getRunningEdges(), getErrorInstance(), stats.
 */
import {
	ANONYMOUS,
	KIND_CREATE,
	STATUS_OK,
	SymbolDiveEdge,
	SymbolDiveInstance,
} from './constants.js';
import {
	Edge,
	isObjectKey,
	ownsEdge,
	recordEdge,
	settleRunning,
} from './store.js';
import type { DiveState } from './state.js';
import { emitCreate } from './hooks.js';
import {
	enterContext, pinError 
} from './wrap.js';
import type {
	DiveStats, FlowEdge 
} from './types.js';

// A construction's parent: the parent instance's latest edge (data flow),
// else — only when truly nested — the execution cursor.
function creationParent (state: DiveState, parent: object | undefined): Edge | null {
	if (isObjectKey(parent)) {
		const parentEdge = state.latestEdges.get(parent) ?? null;
		return parentEdge;
	}
	const result = state.activeDepth > 0 ? state.cursor : null;
	return result;
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
export function recordCreation (state: DiveState, name: string, instance: object, parent?: object): void {
	const edge = recordEdge(state, KIND_CREATE, name || ANONYMOUS, instance, creationParent(state, parent));
	// recordCreation fires at postCreation: the construction HAS completed.
	// 'running' means genuinely unsettled — a finished construction must not
	// wear it. Duration is unmeasured at this level (the hook moment IS the
	// completion), so 0, mirroring recordCreationError.
	edge.status = STATUS_OK;
	settleRunning(state, edge);
	edge.duration = 0;
	// The constructed instance arrives as an argument — never ambient
	edge.instanceSource = 'explicit';
	// Opt-in 'create', NOT 'enter': the adapter owns this lifecycle via
	// mnemonica's hooks; enter would double-report there (see the event's
	// doc in types.ts).
	emitCreate(state, edge, undefined);
	enterContext(state, instance);
}

/**
 * Record a FAILED construction as a 'create' edge (status: 'error') under the
 * surviving parent, and pin the error to it: the failure is recoverable off
 * the error object itself. Integration primitive — the adapter-level wiring
 * calls it from creationError.
 */
export function recordCreationError (state: DiveState, name: string, errored: unknown, parent?: object): void {
	if (errored instanceof Error) {
		// Record the FAILED creation as an edge in the parent's branch, then
		// pin the error to it — the flight recorder for "the data flow failed".
		const edge = recordEdge(state, KIND_CREATE, name || ANONYMOUS, parent, creationParent(state, parent));
		edge.duration = 0;
		// The surviving parent arrives as an argument — never ambient
		if (isObjectKey(parent)) {
			edge.instanceSource = 'explicit';
		}
		pinError(state, errored, edge, parent);
		// Emitted after pinError so subscribers see the failure already
		// pinned; same opt-in 'create' event as recordCreation.
		emitCreate(state, edge, errored);
	}
	if (isObjectKey(errored)) {
		// Only an object can carry the context — a thrown string/number
		// must not become current()
		enterContext(state, errored);
	} else if (parent) {
		enterContext(state, parent);
	}
}

/**
 * The instance executing right now (the "newest-wins" switcher).
 * For anything beyond single-flow code, prefer getFlow() — the trace holds
 * the truth even when concurrent flows make "current" ambiguous.
 */
export function current (state: DiveState): object | undefined {
	const result = state.lastContext;
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
export function getFlow (state: DiveState, target?: unknown): FlowEdge[] {
	const branch: FlowEdge[] = [];
	let edge = flowStart(state, target);
	while (edge) {
		// push in walk order (newest first), one reverse at the end —
		// unshift moved the whole array each step (quadratic on long chains)
		branch.push(copyEdge(edge));
		edge = state.parents.get(edge);
	}
	branch.reverse();
	return branch;
}

/**
 * getFlow(target).length without copying a single edge — for tests and
 * benchmarks asserting how long a chain something keeps alive.
 */
export function chainDepth (state: DiveState, target?: unknown): number {
	let depth = 0;
	let edge = flowStart(state, target);
	while (edge) {
		depth++;
		edge = state.parents.get(edge);
	}
	return depth;
}

// The edge a flow walk starts from: an edge (a copy resolves to its live
// original — see copySource in state.ts), the edge pinned to an Error, the
// current cursor, or an object's latest edge. Foreign edges — recorded by
// another dive — never anchor a walk here (ownsEdge is the boundary).
function flowStart (state: DiveState, target: unknown): Edge | undefined {
	if (target instanceof Edge) {
		if (!ownsEdge(state, target)) {
			return undefined;
		}
		const source = state.copySource.get(target);
		const resolved = source ? source.deref() : target;
		return resolved;
	}
	if (target instanceof Error) {
		const pinned = pinnedEdge(target);
		const anchored = pinned !== undefined && ownsEdge(state, pinned) ? pinned : undefined;
		return anchored;
	}
	let result: Edge | undefined;
	if (target === undefined) {
		result = state.cursor ?? undefined;
	} else if (isObjectKey(target)) {
		result = state.latestEdges.get(target);
	}
	return result;
}

// The edge object pinError put on an error (undefined when none).
function pinnedEdge (error: object): Edge | undefined {
	const pinned: unknown = SymbolDiveEdge in error ? error[ SymbolDiveEdge ] : undefined;
	const result = pinned instanceof Edge ? pinned : undefined;
	return result;
}

/**
 * Copy an edge for the public accessors. The instance lives behind the
 * WeakRef getter — a naive spread would READ it at copy time and pin the
 * instance on the copy. Edge.copy() shares the WeakRef instead. Every
 * recorded edge is an Edge — the stores are typed so (runningEdges:
 * Set<Edge>, parents WeakMap<Edge, Edge>), and the param is Edge, never
 * the public interface.
 */
function copyEdge (edge: Edge): FlowEdge {
	const result = edge.copy();
	return result;
}

/**
 * The edges still running right now — the unfinished fibers, i.e. the
 * suspect set for uncaughtException/unhandledRejection attribution,
 * without walking parents. Copies, same semantics as getFlow.
 */
export function getRunningEdges (state: DiveState): FlowEdge[] {
	const result = [ ...state.runningEdges.values() ].map((edge) => copyEdge(edge));
	return result;
}

/**
 * The data pinned to an error. Prefers the instance pinned at the failure
 * site; falls back to the instance of the error's trace edge.
 * Accepts anything (unknown, like getFlow) — non-objects pin nothing.
 * State-free: the pin rides on the error object, so any dive (or build
 * flavor) can read it.
 */
export function getErrorInstance (error: unknown): object | undefined {
	if (!isObjectKey(error)) {
		return undefined;
	}
	const storedPin: unknown = SymbolDiveInstance in error ? error[ SymbolDiveInstance ] : undefined;
	const pinned = typeof storedPin === 'object' && storedPin !== null ? storedPin : undefined;
	if (pinned !== undefined) {
		return pinned;
	}
	const edge = pinnedEdge(error);
	const result = edge ? edge.instance : undefined;
	return result;
}

/**
 * The control surface of one dive — getter FIELDS over its state's counters,
 * read-only, per era (clear() resets them). See the DiveStats doc in
 * types.ts for the field meanings.
 */
export function createStats (state: DiveState): DiveStats {
	const stats: DiveStats = Object.freeze({
		get running (): number {
			const result = state.runningEdges.size;
			return result;
		},
		get recorded (): number {
			const result = state.recordedEdgeCount;
			return result;
		},
		get collectedEdges (): number {
			const result = state.collectedEdgeCount;
			return result;
		},
		get alive (): number {
			const result = state.recordedEdgeCount - state.collectedEdgeCount;
			return result;
		},
		get collectedInstances (): number {
			const result = state.collectedInstanceCount;
			return result;
		},
	});
	return stats;
}

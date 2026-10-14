/**
 * Edge lifecycle hooks — dive PUBLISHES its ground truth (emission, never
 * ingestion; see the DiveHookEvent doc in types.ts for the event semantics).
 * Every function works on the state of the dive whose API was called, so one
 * dive's subscribers never observe another dive's edges.
 */
import type { Edge } from './store.js';
import type { DiveState } from './state.js';
import type {
	AnyFn,
	DiveCreatePayload,
	DiveEnterPayload,
	DiveHook,
	DiveHookEvent,
	DiveHookPayload,
	DiveLeavePayload,
	DiveRecontextPayload,
	DiveSettlePayload,
} from './types.js';

/**
 * Subscribe to an edge lifecycle event. Returns an unregister function.
 * Same shape and philosophy as mnemonica's own registerHook. The public
 * overloads (per-event payload narrowing) live on the Dive class and the
 * package entry; this is the shared implementation.
 */
export function registerHook (
	state: DiveState,
	event: DiveHookEvent,
	hook: DiveHook<DiveHookPayload>
): () => void {
	const subscribers = state.hooks[ event ];
	subscribers.push(hook);
	const unregister = (): void => {
		detachHook(state, event, hook);
	};
	return unregister;
}

export function detachHook (state: DiveState, event: DiveHookEvent, hook: DiveHook<DiveHookPayload>): void {
	const subscribers = state.hooks[ event ];
	const at = subscribers.indexOf(hook);
	if (at !== -1) {
		subscribers.splice(at, 1);
	}
}

/**
 * Detach an exact subscriber by reference — for when the unregister closure
 * returned by registerHook was not kept. No-op for unknown hooks.
 */
export function unregisterHook (state: DiveState, event: DiveHookEvent, hook: DiveHook<DiveHookPayload>): void {
	detachHook(state, event, hook);
}

/**
 * Contained dispatch: every subscriber runs inside its own try, so a throwing
 * hook degrades its own observability and never corrupts the edge, the result,
 * or user code.
 */
export function dispatchHook (subscribers: Array<DiveHook<DiveHookPayload>>, payload: DiveHookPayload): void {
	for (const subscriber of subscribers) {
		try {
			subscriber(payload);
		} catch {
			// a throwing subscriber degrades its own observability, never the trace
		}
	}
}

export function emitEnter (state: DiveState, edge: Edge, args: unknown[]): void {
	const subscribers = state.hooks.enter;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveEnterPayload = { edge, args };
	dispatchHook(subscribers, payload);
}

export function emitLeave (state: DiveState, edge: Edge, result: unknown): void {
	const subscribers = state.hooks.leave;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveLeavePayload = { edge, result };
	dispatchHook(subscribers, payload);
}

export function emitSettle (state: DiveState, edge: Edge, result: unknown, error: unknown): void {
	const subscribers = state.hooks.settle;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveSettlePayload = { edge, result, error };
	dispatchHook(subscribers, payload);
}

export function emitRecontext (
	state: DiveState,
	edge: Edge,
	fn: AnyFn,
	previousContext: object | undefined,
	context: object | undefined
): void {
	const subscribers = state.hooks.recontext;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveRecontextPayload = { edge, fn, previousContext, context };
	dispatchHook(subscribers, payload);
}

export function emitCreate (state: DiveState, edge: Edge, error: unknown): void {
	const subscribers = state.hooks.create;
	if (subscribers.length === 0) {
		return;
	}
	const payload: DiveCreatePayload = { edge, error };
	dispatchHook(subscribers, payload);
}

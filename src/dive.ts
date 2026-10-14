/**
 * The Dive class — an isolated dive of one's own, next to the default dive
 * the package entry exports. The same way mnemonica's createTypesCollection()
 * sits next to its default collection: the free functions keep working on the
 * default dive, and `new Dive()` gives an app (a test suite, a plugin host, a
 * tenant) a trace of its own — own edges, counters, hooks and context,
 * invisible to every other dive.
 *
 * The methods only delegate; the logic lives in the domain files
 * (wrap.ts / flow.ts / hooks.ts / store.ts), each taking the dive's state as
 * its first parameter. State IS the isolation boundary: two dives never read
 * or write each other's stores. The only things dives SHARE are the
 * Symbol.for marks on user objects (wrappedness, pinned errors) — they live
 * on the user's functions and errors, not in any dive.
 *
 * The doc comments on the methods below ARE the public documentation: the
 * package entry re-exports this same surface, bound to the default dive.
 */
import {
	createDiveState,
	type DiveState,
} from './state.js';
import { clearState } from './store.js';
import * as hooks from './hooks.js';
import * as wrapApi from './wrap.js';
import * as flow from './flow.js';
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
	DiveStats,
	FlowEdge,
} from './types.js';

export class Dive {
	readonly #state: DiveState = createDiveState();

	/** this dive's control surface — getter fields over its counters,
	 *  read-only, per era (clear() resets them). See DiveStats. */
	readonly stats: DiveStats = flow.createStats(this.#state);

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
	 *   - Promise results are tapped: the edge closes when the
	 *     whole chain settles, resolved functions are wrapped, rejections pin
	 *     the error to the call's edge
	 */
	wrap<T extends AnyFn> (
		fn: T,
		label?: string
	): T;
	wrap<T extends AnyFn> (
		fn: T,
		context?: object,
		label?: string
	): T;
	// A class constructor is a supported wrap() target at runtime (the wrapper
	// builds it via Reflect.construct — kind 'construct'); typed so the class
	// comes back AS the class: `new Wrapped()` typechecks with no cast
	wrap<C extends abstract new (...args: never[]) => unknown> (
		ctor: C,
		contextOrLabel?: object | string,
		label?: string
	): C;
	wrap<T extends AnyFn> (fn: T, contextOrLabel?: object | string, label?: string): T {
		const result = wrapApi.wrapEntry(this.#state, fn, contextOrLabel, false, label);
		return result;
	}

	/**
	 * Subscribe to an edge lifecycle event. Returns an unregister function.
	 * Same shape and philosophy as mnemonica's own registerHook.
	 */
	registerHook (event: 'enter', hook: DiveHook<DiveEnterPayload>): () => void;
	registerHook (event: 'leave', hook: DiveHook<DiveLeavePayload>): () => void;
	registerHook (event: 'settle', hook: DiveHook<DiveSettlePayload>): () => void;
	registerHook (event: 'recontext', hook: DiveHook<DiveRecontextPayload>): () => void;
	registerHook (event: 'create', hook: DiveHook<DiveCreatePayload>): () => void;
	registerHook (event: DiveHookEvent, hook: (...args: never[]) => void): () => void {
		// The public overloads narrow the payload per event; internally every
		// subscriber is stored against the union and dispatched within its own try.
		const stored = hook as DiveHook<DiveHookPayload>;
		const unregister = hooks.registerHook(this.#state, event, stored);
		return unregister;
	}

	/**
	 * Detach an exact subscriber by reference — for when the unregister closure
	 * returned by registerHook was not kept. No-op for unknown hooks.
	 */
	unregisterHook (event: 'enter', hook: DiveHook<DiveEnterPayload>): void;
	unregisterHook (event: 'leave', hook: DiveHook<DiveLeavePayload>): void;
	unregisterHook (event: 'settle', hook: DiveHook<DiveSettlePayload>): void;
	unregisterHook (event: 'recontext', hook: DiveHook<DiveRecontextPayload>): void;
	unregisterHook (event: 'create', hook: DiveHook<DiveCreatePayload>): void;
	unregisterHook (event: DiveHookEvent, hook: (...args: never[]) => void): void {
		const stored = hook as DiveHook<DiveHookPayload>;
		hooks.unregisterHook(this.#state, event, stored);
	}

	/**
	 * Switch the "newest-wins" context behind current(). Integration primitive:
	 * adapter-level wiring calls it when a lifecycle event enters an instance's
	 * context (e.g. preCreation enters the parent, postCreation the instance).
	 * Deliberately NOT used for trace parentage — concurrent flows cannot
	 * corrupt the trace through it.
	 */
	enterContext (instance: object | undefined): void {
		wrapApi.enterContext(this.#state, instance);
	}

	/**
	 * Check if a function is already dive-wrapped. Integration primitive:
	 * adapter-level wiring uses it to avoid double-wrapping constructor args.
	 * The mark is a process-global Symbol.for key on purpose: wrappedness is a
	 * property of the FUNCTION OBJECT, shared by every dive (and by both build
	 * flavors) that meets it.
	 */
	isWrappedFunction (value: unknown): boolean {
		const result = wrapApi.isWrappedFunction(value);
		return result;
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
	 */
	wrapConstructorArg (fn: AnyFn, context: object | undefined): AnyFn {
		const result = wrapApi.wrapConstructorArg(this.#state, fn, context);
		return result;
	}

	/**
	 * Upgrade an as-yet-unused constructor-arg callback to the built instance.
	 * Integration primitive — the adapter-level wiring calls it from postCreation.
	 * No-op for non-wrapped args, or callbacks already invoked during construction.
	 */
	upgradeConstructorArg (arg: unknown, instance: object): void {
		wrapApi.upgradeConstructorArg(arg, instance);
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
	 * See AGENTS.md "Internals".
	 */
	wrapInstanceMethods (instance: object): void {
		wrapApi.wrapInstanceMethods(this.#state, instance);
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
	recordCreation (name: string, instance: object, parent?: object): void {
		flow.recordCreation(this.#state, name, instance, parent);
	}

	/**
	 * Record a FAILED construction as a 'create' edge (status: 'error') under the
	 * surviving parent, and pin the error to it: the failure is recoverable off
	 * the error object itself. Integration primitive — the adapter-level wiring
	 * calls it from creationError.
	 */
	recordCreationError (name: string, errored: unknown, parent?: object): void {
		flow.recordCreationError(this.#state, name, errored, parent);
	}

	/**
	 * The instance executing right now (the "newest-wins" switcher).
	 * For anything beyond single-flow code, prefer getFlow() — the trace holds
	 * the truth even when concurrent flows make "current" ambiguous.
	 */
	current (): object | undefined {
		const result = flow.current(this.#state);
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
	getFlow (target?: unknown): FlowEdge[] {
		const result = flow.getFlow(this.#state, target);
		return result;
	}

	/**
	 * getFlow(target).length without copying a single edge — for tests and
	 * benchmarks asserting how long a chain something keeps alive.
	 */
	chainDepth (target?: unknown): number {
		const result = flow.chainDepth(this.#state, target);
		return result;
	}

	/**
	 * The edges still running right now — the unfinished fibers, i.e. the
	 * suspect set for uncaughtException/unhandledRejection attribution,
	 * without walking parents. Copies, same semantics as getFlow.
	 */
	getRunningEdges (): FlowEdge[] {
		const result = flow.getRunningEdges(this.#state);
		return result;
	}

	/**
	 * The data pinned to an error. Prefers the instance pinned at the failure
	 * site; falls back to the instance of the error's trace edge.
	 * Accepts anything (unknown, like getFlow) — non-objects pin nothing.
	 * State-free: the pin rides on the error object, so any dive (or build
	 * flavor) can read it.
	 */
	getErrorInstance (error: unknown): object | undefined {
		const result = flow.getErrorInstance(error);
		return result;
	}

	/**
	 * Reset everything: object links, the running store, cursor, depth, context,
	 * counters, and the registered lifecycle hooks — of THIS dive. Useful for
	 * testing — note that adapter-level subscribers must re-register after a
	 * clear().
	 */
	clear (): void {
		clearState(this.#state);
	}
}

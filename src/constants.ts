/**
 * The module-level vocabulary: Symbol.for keys and the status/kind/name
 * constants every domain file shares.
 *
 * The symbols are Symbol.for-registered (process-global registry) on purpose:
 * the dual build (ESM + CJS flavors in one process) and separate Dive
 * instances must agree on wrappedness and pinned-error provenance — the marks
 * live on the user's functions and errors, not in any dive's state.
 */

export const SymbolDiveInstance = Symbol.for('mnemonica.dive.instance');
export const SymbolDiveEdge = Symbol.for('mnemonica.dive.edge');
export const SymbolDiveWrapped = Symbol.for('mnemonica.dive.wrapped');
export const SymbolDiveArgHolder = Symbol.for('mnemonica.dive.argHolder');
// Origin info installed on every wrap() wrapper: the ORIGINAL fn and the
// captured context. This is what makes re-wrap shadowing possible — a
// wrapper always knows what it wraps and whose story it tells.
export const SymbolDiveOriginal = Symbol.for('mnemonica.dive.original');
export const SymbolDiveContext = Symbol.for('mnemonica.dive.context');
// Identity of a wrap SITE (not the wrapped fn): the callsite is captured once
// per wrap and the label is the user's optional grouping tag. Together with the
// caption they are the runtime half of the AoT join — tactica's eds.json
// records wrap entries in the same file:line:col format.
export const SymbolDiveCallsite = Symbol.for('mnemonica.dive.callsite');
export const SymbolDiveLabel = Symbol.for('mnemonica.dive.label');
export const SymbolDiveCaption = Symbol.for('mnemonica.dive.caption');

// The domain vocabulary, defined once — a single source of truth for every
// status, kind, and fallback name the trace can carry.
export const STATUS_RUNNING = 'running';
export const STATUS_OK = 'ok';
export const STATUS_ERROR = 'error';
export const KIND_CREATE = 'create';
export const KIND_CALL = 'call';
export const KIND_CONSTRUCT = 'construct';
export const KIND_METHOD = 'method';
export const KIND_RECONTEXT = 'recontext';
export const ANONYMOUS = 'anonymous';
export const FN_NAME = 'name';

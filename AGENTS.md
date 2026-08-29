# AGENTS.md — @mnemonica/dive

Guidance for AI agents modifying this package. If you are *using* dive in
your own project, start with [`README.md`](./README.md).

## What this is

Execution-flow tracing for the mnemonica stack: context is pinned to
instances, errors carry their data, and the trace ring records what ran
(create/call edges, status, duration, parentage). The design decisions and
their reasons live in [`DECISIONS.md`](./DECISIONS.md) — read it before
changing behavior; entries there are settled, not suggestions.

## Build & test

```bash
npm run build   # tsc → build/
npm test        # tsc (pretest) && vitest run — always a FRESH build
```

`build/` is gitignored; nothing here is committed from it.

## Testing rules (learned the hard way)

1. **Tests that execute compiled output must rebuild first.** Some tests
   spawn child processes against `build/` (e.g. `test/uncaught-real.spec.ts`
   → `test/fixtures/uncaught-child.mjs`). `pretest` runs `tsc` for exactly
   this reason — never run `vitest` bare and trust the result; a stale
   `build/` makes behavior tests pass against yesterday's semantics. This
   exact trap once hid a breaking trace-semantics change locally that CI
   caught.
2. **Behavior changes must break a test.** Pin behavior with snapshot-like
   assertions: deep-equal the full observed shape (edge kinds AND statuses
   AND durations), not just the fields you touched. If you change trace
   semantics and no test fails, the suite has a hole — add the pinning test
   first, then change the code.
3. **Cross-package version bumps re-run the consumer's suite.** A dependency
   range bump (e.g. adapter onto a new dive) is a behavior change for the
   consumer even with zero source edits — old pins can keep tests green
   against the previous major/minor semantics.

## Style

Tabs, aligned colons in object literals, return-via-variable (every return
goes through an intermediate const — debugger rule), no `any`.

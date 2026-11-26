---
name: typescript
description: TypeScript conventions for this repo's extension code — type-system discipline, narrowing, boundary parsing, and tests. Use when writing or editing any .ts file here.
---

# TypeScript

Apply to code you write or edit. This shapes new code; it is not a mandate to refactor code you are only reading.

| Rule | Summary |
| --- | --- |
| Discriminated unions | Model variants with a `kind` literal discriminant so impossible states cannot be represented. No optional-field bags. |
| Constructive modeling | Build the shape so the illegal value cannot be constructed: `[T, ...T[]]` for non-empty, `start` plus `duration` for a range. Not a runtime guard. |
| Simplest total type | Keep `T[]` while every operation on it stays total. Strengthen to a non-empty type only where the loose type forces `!`, a cast, or a "should never happen" throw. |
| `unknown` over `any` | External data is `unknown`. No `any`. |
| Schemas before guards | Tool params, persisted config, and anything crossing a process boundary go through typebox: `Type.Object(...)` with `Static<typeof T>` as the type. A hand-written property-by-property guard is the last resort, not the first. |
| Boundary validation | Parse where data crosses in, into a named domain type; trust types inside. `Record<string, unknown>` stops at that parse. |
| `as` | Cast only after validation. `as const` and the `Static<typeof schema>` type at a parsed boundary are fine; any other `as` is a crash waiting. |
| Narrowing hierarchy | Discriminant switch > `in` > `typeof`/`instanceof` > user-defined guard > `as`. |
| Type guards | A guard must verify its claim — a lying guard is worse than `as` because the bug hides behind a name. Name them `isX` or `hasX`. |
| Exhaustiveness | `const _exhaustive: never = x;` in the default arm, so a new variant becomes a compile error. |
| `satisfies` over `as` | Validates the value without widening literal types. |
| Schema-derived types | Reach for `Pick`/`Omit`/`Parameters`/`ReturnType`/`Awaited`/`typeof` before declaring a new interface. |
| Branded types | Only where mixing two primitives is a real hazard: brand with a verifying guard (`input is AgentId`), never with `as`. |
| Object args | Pass an object when an option list will grow. One or two arguments stay positional — that is this repo's existing style. |
| Tests | `node:assert/strict` scripts under `.script/test/`, run by `.script/test/run-all.mjs`. Don't mock what you can run. |
| No console | No `console.log` in shipped extension code; diagnostics go through the extension's own UI or log path. |

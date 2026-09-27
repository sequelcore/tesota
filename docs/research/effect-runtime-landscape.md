# Effect runtime landscape (September 2026)

Whether Tesota's orchestration should run on [Effect](https://effect.website/)
v4 rather than on the platform's own promises, abort signals and disposal.
Researched on 2026-09-27 against `effect@4.0.0-rc.117` and Effect's `main` at
`0cf7655`, OpenCode's source at `b471c2b`, and Tesota's `dev` at `266413b6`.
It informs decision 038. Recheck Effect's status before relying on it: v4 was
still a release candidate.

## Why it matters

Tesota's third principle keeps failures, timeouts, cancellations and
unconfirmed effects distinct, and its shell owns many resources per session:
a workspace, an execution environment with a proxy and, in the native
sandbox, a mapped drive, a working agent, explorers and an advisor. A fix
before this research found quitting abandoned the native sandbox's drive,
because a release was started and not awaited. Effect claims to make such
lifecycles structural: resources released when their scope closes,
interruption that reaches in-flight work, and errors and dependencies in the
types, which it also presents as better feedback for coding agents.

## What Effect v4 is now

- **Status.** 115 v4 prereleases from 2026-02-18; the release candidate on
  2026-08-12 said "no more broad breaking changes planned", and nine more
  followed by 2026-09-21. Stable 4.0 is announced for "Q3/Q4 2026"; npm's
  `latest` is still 3.x.
- **Changes after the candidate.** `Config` constructors were renamed, the
  socket API and the RPC serializations were reworked, and on 2026-09-22
  every `effect/unstable/*` module moved to `effect/*` with no compatibility
  exports. `Schema.TaggedErrorClass`, which beta-era guides use, is not
  exported in rc.117.
- **Stability tiers.** Modules marked `@stability unstable`, among them
  `process`, `http`, `rpc`, `socket`, `cli` and `observability`, may break in
  minor releases after 4.0; `@stability experimental` ones in patches. The
  core (`Effect`, `Scope`, `Layer`, `Stream`, `Queue`, `Semaphore`) follows
  semver.
- **Guidance for agents.** Effect ships an `LLMS.md` and tells agents to read
  the installed source, since older examples are "outdated or incorrect".

## Who uses it

OpenCode is the listed user whose use can be read: about 230 of the 358
source files in its core package import Effect, pinned to `4.0.0-beta.83`,
not the candidate. Its rules for agents replace hand-kept
`Promise | undefined` fields with `Effect.cached`, give each open directory a
scoped cache, and fork background work into scopes. Its issues show what
adoption moves rather than removes: a layer-assembly error that failed every
prompt in one release
([#48803](https://github.com/anomalyco/opencode/issues/48803)), an
event-listener leak in the Effect runtime used with the AI SDK
([#34574](https://github.com/anomalyco/opencode/issues/34574), open),
background failures swallowed with `Effect.ignore`
([#36366](https://github.com/anomalyco/opencode/issues/36366)), `Effect.die`
used for expected failures
([#40091](https://github.com/anomalyco/opencode/issues/40091)), plugins
broken when their Effect version drifted from the server's
([#43322](https://github.com/anomalyco/opencode/issues/43322)), and test
harnesses that hide Effect's logs
([#51214](https://github.com/anomalyco/opencode/issues/51214)). No public
architectural evidence was found for the other users the Effect site lists.

## What it would replace in Tesota

| Tesota on `dev` | Effect | Gain |
| --- | --- | --- |
| A session's workspace, environment and agent kept as memoized promises, reset on failure | A scope per session; `Effect.cached`, `RcMap` | High |
| Releasing them on close, quit and sandbox switch, in hand-written order | `Scope.close`, finalizers in reverse order | High |
| The native sandbox's proxy and drive, released only by `dispose` | `acquireRelease` | High |
| Two semaphores (session operations, explorers) and an application queue | `Semaphore` | Medium |
| One `AbortController` per session operation | Fibers in a `FiberMap` | Medium |
| Background preparation and naming, outliving their session | `forkIn` the session's scope | Medium |
| Activity to the terminal through callbacks | `PubSub`, `Stream` | Low now; high for several clients of the session service |
| Retries | `Schedule` | None: Pi retries provider calls, and Tesota retries no command silently |
| The decision loop, correction and the proved rules | — | None: pure code with result unions, proved by LemmaScript, which cannot check Effect code |

## What it would not settle

- **Unconfirmed stops.** An engine that does not confirm it stopped, such as
  a Pi prompt, MXC or `sbx`, stays unconfirmed under any runtime. A probe
  (findings, 2026-09-27) interrupted `Effect.tryPromise` over a promise that
  ignores its abort: the interruption returned at 103 ms, as a clean
  interruption, while the work ran until 2003 ms. Tesota's `unsettled` and
  `unconfirmed` outcomes would still be written by hand, with
  `Effect.callback` and an explicit settlement; the default path hides them.
- **A closed terminal or a crash.** Effect's `runMain` handles `SIGINT` and
  `SIGTERM` only; closing a Windows console sends `SIGHUP`, and pi-tui reads
  Ctrl+C as a key. The native sandbox's drive leases and sweep stay needed.
- **Swallowed errors.** OpenCode's issues show they remain possible.

## The platform's own alternative

Node 24.15 and Bun 1.4.2, the versions Tesota pins, both run
`AsyncDisposableStack`: releases run in reverse order, a failed release does
not stop the others, and their errors arrive together as a
`SuppressedError`. That gives the structural release Effect's scopes give,
without a dependency, though not interruption that reaches in-flight work or
structured concurrency.

## Costs

- **Churn** during the candidate period, above, and version coupling between
  any packages that exchange Effect values or schemas.
- **Readability for contributors.** Generators with `yield*` read like
  `async` code, but layers, the error and dependency channels, and fiber
  semantics are a new model for a contributor who knows TypeScript.
- **Agents.** Typed dependencies and errors turn some mistakes into compile
  errors; against that, most models learned v2 and v3, whose names v4
  changed, and the common mistakes above typecheck.
- **Start-up.** Importing Effect's core, Schema and Stream took about 75 ms
  in Bun, beside about 340 ms for Pi's agent and terminal packages.

## Conclusion for Tesota

Effect's value for Tesota is real but narrow today: about 150 lines of
lifecycle plumbing in `tesota-shell-command.ts` and the providers, which the
platform's own disposal and one semaphore also fix. It would not model the
outcomes Tesota most needs to keep distinct, and v4's modules for processes,
HTTP and RPC are the unstable ones. Its strengths match the planned session
service best: a long-lived process owning every session's resources for
several clients, with streams of activity and a protocol. So the lifecycle
issues were fixed on the platform's primitives (decision 038), and the
choice is to be taken again, with evidence, before the service is built:
the session lifecycle built twice, on Effect and on the platform's
primitives, against the same fault-injection tests, with success criteria
registered first. Those criteria are exact outcome classification and no
resource left open for every failure or stop injected at each acquisition
step, then code size, lifecycle flags, the time and first-pass correctness of
a change made by a person and by a coding agent, and readability for someone
who does not know Effect.

## Sources

- [Effect 4.0 release candidate](https://effect.website/blog/releases/effect/40-rc),
  [August recap](https://effect.website/blog/effect-v4-rc-august-recap),
  [v4 beta](https://effect.website/blog/releases/effect/40-beta)
- [MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md),
  [LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md), and the
  source of `Effect.tryPromise` and `NodeRuntime`
- [OpenCode](https://github.com/anomalyco/opencode): `packages/opencode/AGENTS.md`
  and the issues above; [Kit Langton, "Effectifying OpenCode"](https://www.youtube.com/watch?v=-mL7VVvkLGM)

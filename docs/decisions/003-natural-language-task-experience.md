# 003: Natural-language task experience

Status: proposed product direction. Read-only `task propose` and the first
argument-free conversational entry point are implemented and locally verified.
The shell can answer, request clarification or propose a task; only proposal paths
have stored-OAuth qualification. Approval, run grants and general execution are not
implemented.

## Problem

Tesota can execute application-registered tasks, but an operator cannot yet state
an ordinary repository goal and let Tesota determine the affected files. Requiring
the operator to enumerate files would expose an implementation detail and fail on
the common case where discovering the correct scope is part of the work. Giving a
model unrestricted repository and shell authority would discard Tesota's existing
scope, evidence and human-decision boundaries.

The interaction therefore needs to make natural language convenient without
treating natural language, a model-authored plan or persisted JSON as executable
authority.

## Research basis

This proposal was formed from hands-on inspection of the installed Codex, Claude
Code and OpenCode command surfaces; source and tests in the local Codex, Gemini
CLI, OpenCode, Pi, Gentle Pi and Gentle AI reference checkouts; current vendor
documentation; and public issue reports about approval friction. The reference
revisions were:

| Reference | Revision | Relevant observation |
| --- | --- | --- |
| Codex | `32329b289d05eb6a3f8e35c267ceb25ba46716a2` | Worktree isolation, sandbox policies and bounded permission expansion are runtime concepts, not prompt conventions. |
| Gemini CLI | `3818efbbfbf8ef029ef53a6ab1093db39971ce83` | Plan mode accepts a goal in natural language, restricts tools during research and requires formal approval before implementation. |
| OpenCode | `3016830e253492ef41b6cc00dbed623e5989279b` | Its terminal UI makes a conversational session the normal entry point; permission rules resolve to allow, ask or deny and can be narrower than a whole tool. |
| Pi | `1dd2354052f7dd9fcdcc3097b87cf4b377853a74` | Project trust and execution isolation are different boundaries; Pi deliberately relies on an external sandbox. |
| Gentle Pi | `db788aefa2cdbc3504ab7723c1f270ebbfe29caa` | Gentle Shell is a package-owned visual layer over Pi with a framed prompt, live status, working-tree changes and inspectable subagents; it extends Pi without making the renderer the agent engine. |
| Gentle AI | `a440e791c342b69ca79f7759e697fc88c1272ca5` | Small requests should avoid visible planning ceremony, while substantial work benefits from explicit proposal, implementation and review phases handled through the agent's normal surface. |

The vendor contracts converge on read-only exploration before consequential
changes, visible permission modes, isolated execution and reviewable results.
They differ on how much approval is per action. Community reports consistently
identify two opposite failures: repetitive prompts train users to approve without
reading, while broad or poorly displayed auto-approval makes active authority hard
to understand. Examples include the Gemini CLI reports on
[permission fatigue](https://github.com/google-gemini/gemini-cli/issues/5256),
[intent-sized approvals](https://github.com/google-gemini/gemini-cli/issues/18268),
and the Codex reports on [reusable authorization scope](https://github.com/openai/codex/issues/17623)
and [time- or use-bounded approval](https://github.com/openai/codex/issues/11176).

This evidence supports a task-sized grant: one meaningful approval for the work
the operator asked for, with a separate, precise prompt only when that boundary
must expand.

The primary published references were the current
[Gemini CLI plan-mode contract](https://geminicli.com/docs/cli/plan-mode/),
[Claude Code security boundary](https://code.claude.com/docs/en/security),
[OpenCode permission model](https://opencode.ai/docs/permissions/) and
[Codex sandbox and approval guidance](https://developers.openai.com/codex/security).
Public issue reports are experience evidence, not proof that every reported defect
still exists in the cited product version.

## Decision

The default interaction begins with a natural-language **message**. It may be a
repository question, a request for change or an ambiguous statement requiring one
clarification. File paths, tests and constraints are optional hints; the operator
does not need to classify the message or know the implementation scope in advance.

Tesota first performs **discovery** against a named committed baseline using a
read-only repository view. Discovery may inspect tracked baseline content and
repository guidance, but it cannot edit, execute repository code, use network
access or load executable project customization merely because the model requests
it. Project trust is resolved before repository-owned executable configuration is
loaded. Relevant dirty source paths are reported rather than silently incorporated
into the candidate baseline.

Discovery uses Tesota-owned listing, search and read operations with explicit
file exclusions, byte and operation limits. A trusted project is not permission to
disclose every tracked file: denied credential and sensitive-data paths remain
unreadable. The configured provider connection is the inference transport and is
disclosed as such; it is distinct from model-controlled network tools, web access
or candidate-process network access, which remain denied during discovery.

Before approval, Tesota displays the committed baseline and known working-tree
changes that are excluded from it. If a dirty or untracked path materially affects
a proposed write, read dependency or check definition, the proposal is blocked
until the operator selects a suitable committed baseline or explicitly chooses to
work against the displayed historical state. Tesota does not commit, stash or
import those changes. Unrelated working changes do not block the proposal.

Discovery submits exactly one parsed result. An **answer** cites files actually
observed from the committed baseline. A **clarification** asks one question needed
to distinguish materially different outcomes. A **task proposal** represents a
requested change. Intent selection never changes the available tools or grants
authority; all three variants run behind the same read-only boundary. This avoids
making a model classification into a permission decision.

A compact task proposal contains:

- the understood outcome and observable completion conditions;
- the baseline and proposed readable and writable paths;
- the applicable checks selected from trusted, application- or repository-owned
  check definitions;
- network, external-system or other consequential effects, normally none;
- known uncertainty and the limit that would cause Tesota to stop.

The proposal is an explanation, not authority. For a small task it should fit in
one terminal card and require no separate formal planning ceremony. A substantial
or materially ambiguous task can include alternatives and receive operator
feedback before it is ready. A repository-owned command is not trusted merely
because it is present in the repository. Each proposed check identifies the
trusted definition, immutable obligation inputs, candidate subject and sandbox
policy. Candidate-authored or candidate-modified tests may provide additional
evidence, but cannot silently replace the original obligation. A requested change
to an obligation is shown as part of the task rather than verified by that same
changed obligation.

The operator can approve the proposal, revise the request or cancel. Approval
does not make arbitrary proposal fields executable. Tesota validates the exact
proposal against its supported operations, path policy, trusted checks, effects
and platform enforcement. Only an admitted proposal causes Tesota, rather than
the model, to issue an immutable **run grant** bound to its baseline, read boundary,
expected path states, permitted create, replace or delete operations, check
identities, effects and limits. Unsupported proposals remain visible and
explicitly non-executable. The run grant is the only authority for candidate
execution. Persisted proposals and
model text remain untrusted evidence and cannot enlarge it.

Within the run grant, Tesota executes without asking about each file or each
predeclared check. Writes occur only in an independent candidate checkout through
one active writer. Candidate code and checks run in an enforceable sandbox with
network denied unless the grant explicitly says otherwise. Repository instructions
can guide the work but cannot override the grant. Ordinary reads within the
admitted baseline read boundary do not prompt again; denied sensitive paths and
reads outside that boundary require a scope change.

When execution needs another write path, check, external read, network access or
other effect, it stops and presents a **scope change**: the exact delta, why it is
needed and what remains possible if it is denied. Approval creates a successor
grant version for that delta. It does not turn into permanent repository-wide
permission. Related paths and effects needed for one dependency are aggregated
into one meaningful request. Denial is returned to the agent so it can adapt or
finish honestly.

The interaction always displays the current lifecycle state and active boundary:
`discovering`, `awaiting_approval`, `executing`, `needs_scope`, `checking`,
`ready_for_review`, or a terminal failure or interruption. Progress emphasizes
changed files, current check, elapsed time and observed consumption instead of a
stream of internal reasoning. An interrupt request immediately stops new action
admission. Tesota then reports observed process settlement or unresolved
termination; the request itself never counts as cancellation. Old grant versions
cannot be replayed and no successor may execute concurrently while settlement is
unresolved. The retained evidence supports a later explicit recovery decision.

Completion freezes the candidate and presents the outcome first: change summary,
diff, applicable check evidence, unverified claims and observed consumption. Human
`accept` or `reject` remains separate from model completion and passing checks;
promotion remains a later explicit operation over the exact accepted bytes.

The first surface should be an inline terminal workflow with plain-text output and
keyboard-operable choices. A richer TUI is optional later. Product behavior and
evidence records must not depend on a particular renderer.

This inline workflow is the intended primary product surface, not a presentation
layer to add after a general runtime is complete. Running `tesota` without a
subcommand should open one conversational session in the current repository. The
operator states the request, reviews the proposal, approves the task-sized scope,
follows execution and receives the diff, checks and acceptance choice without
copying proposal IDs or assembling lifecycle commands. Composable commands such
as `task propose`, `task start`, review and promotion remain useful automation,
diagnostic and test seams behind that experience.

OpenCode is a direct reference for making a terminal conversation the normal
entry point. Gentle Shell is a direct reference for placing a native visual layer
over Pi while preserving the underlying engine, and Gentle AI supplies the
separate lesson that small work stays direct and internal planning or review
machinery should not become mandatory user-visible ceremony. Tesota adopts those
experience properties, not either project's renderer, theme, permission defaults
or lifecycle ownership.

## Canonical concepts

| Concept | Meaning | Owner |
| --- | --- | --- |
| Message | The operator's natural-language question, desired change or ambiguous statement | Conversation/input boundary |
| Answer | A read-only response grounded in observed baseline files | Discovery boundary |
| Clarification | One question needed before answering or proposing accurately | Discovery boundary |
| Task proposal | Tesota's read-only interpretation of outcome, scope, checks and effects | Discovery boundary |
| Run grant | Immutable machine-enforced authority issued after approval | Tesota runtime |
| Scope change | A proposed delta to an existing grant | Tesota runtime and operator decision |
| Candidate | Isolated working state bound to a baseline and grant lineage | Candidate lifecycle |
| Check evidence | What a named verifier observed about exact candidate inputs | Verification owner |
| Review decision | Human acceptance or rejection of exact reviewed candidate bytes | Review owner |
| Promotion | Explicit application of accepted bytes to the source checkout | Promotion owner |

Do not call the task proposal a grant, approval or acceptance. Do not call a passing
check acceptance. These distinctions must survive in schemas, UI wording, tests
and retained evidence.

## Alternatives rejected

**Require the operator to name every file.** This is safe but makes repository
understanding the operator's job and cannot handle discovered dependencies well.
Paths remain useful optional constraints.

**Treat the initial natural-language request as unrestricted edit authority.** This
is fast but gives no trustworthy account of what the model inferred before acting.
It also makes later scope disputes impossible to resolve cleanly.

**Ask before every edit or command.** This exposes tool mechanics instead of the
operator's intent and creates the approval fatigue reported across current tools.

**Persist a model-authored executable manifest.** This would let untrusted output
become its own authority and conflict with the current application-owned registry.

**Adopt a full-screen TUI before the contract.** The workflow can be exercised and
tested through an inline CLI first; presentation should not become the semantic
owner.

**Defer the operator surface until general execution is complete.** This would
repeat the sequencing problem that led to Tesota: internal capabilities could
grow without exercising the ordinary development loop. The thin conversational
surface and its first narrow executable consumer must be developed together.

## Consequences and implementation order

The first enabling increment is the implemented read-only `task propose` flow for
Tesota's own repository. It accepts a natural-language request, binds a committed baseline,
uses bounded discovery, reports relevant dirty-path conflicts and retains a
strictly parsed proposal with no execution authority. Its acceptance test is that
the operator can describe a real multi-file task without naming files and receive
an accurate, concise proposed write set and checks, while attempted mutation,
execution and network use fail closed. Local fake-provider tests establish these
boundaries; stored-OAuth runs qualified both dirty-input blocking and a clean
`ready` proposal. They do not establish proposal correctness or executable
admission.

The argument-free shell now generalizes that same boundary into one read-only turn
whose strict result is `answer`, `clarification` or `task_proposal`. The explicit
command remains proposal-only. Answers and clarification are not persisted and no
variant can create a candidate or authority. Local fake-provider tests establish
the result contract and observed-evidence rule; live usefulness for questions and
clarification remains unqualified. Multi-turn continuation is deliberately deferred
until real use demonstrates the required session semantics.

The next product increment is a thin inline `tesota` session backed by the first
deliberately narrow `task start <proposal-id>` consumer. The shell and consumer
must exercise one real operator-described Tesota change beyond paraphrasing an
existing registered repair. The flow discovers and displays scope, permits request
revision by producing a fresh proposal, obtains one approval, edits an independent
candidate through supported operations, runs applicable admitted checks, presents
the diff and evidence for a separate human decision, and refuses promotion after
a conflicting source edit.

This slice keeps authority narrow by rejecting unsupported proposal fields, a
second start of the same grant and concurrent or resumed execution. It does not
need executable successor grants, in-session scope expansion, session continuation,
arbitrary shell commands, external effects or mandatory Gentle review. A candidate
command that does run must use an enforceable sandbox; a task with no applicable
binary oracle reports that limitation instead of inventing a pass. Cancellation
must stop new action admission and report observed or unresolved settlement, but
richer recovery follows only after real interrupted use requires it.

This direction adds one confirmation before a new general task writes anything.
Registered tasks can remain a faster predeclared path because their scope and
checks already have a trusted owner. The design does not yet choose the proposal
schema, trust-store format, sandbox implementation or shell rendering library;
those choices require implementation evidence and platform tests.

# Agents

Tesota runs several model sessions for one request, each in a fixed role.

## The working agent

The working agent is one Pi session per shell session, started with exactly
Tesota's tools and system prompt: no Pi extensions, skills, prompt templates
or context files are loaded. Its tools are read, grep, find and ls, edit and
write, all confined to the project, or its copy, and refusing the files hidden as possible credentials, and bash, which runs in the
session's execution environment ([execution](execution.md)); explorers add
`explore`. Edit, write and bash follow the operator's permission mode, read
at each call: in Read only, edit and write refuse and every command asks
([execution](execution.md#where-commands-run)). Its conversation is saved, so it survives a restart and keeps its
context across requests and correction rounds. It is closed only when its
session closes.

The agent is told not to commit, push or change Git history, and to end each
turn with what it changed and what the operator should verify. It is told to
lead with the answer or the result in as few sentences as it needs, without
restating the question. It is the only agent that writes.

### Changing the agent's model

- **A session keeps its agent's model.** The first time its agent starts,
  the session records the model it runs on, from `tesota roles agent`;
  afterwards that choice sets only new sessions, so a restarted session never
  lands on another engine behind its old transcript.
- **`/model`** opens a picker, as in Claude Code and Codex
  (`src/tesota-shell-model-picker.ts`): every offered model with who pays for
  it, the session's marked; typing filters it, left and right choose a
  reasoning level the highlighted model accepts, as Claude Code's effort
  slider does, and Enter switches. `/model <route:model>` still switches
  directly, and `/model default` returns to the role's. The rule is `modelSwitch` in `src/verification/model-switch.ts`,
  proved by `bun run formal:check`: the same model changes nothing; a model
  on the **same engine** switches in place and the conversation continues
  (Pi's `setModel`, which adapts earlier messages to the new model, across
  the `codex` and `anthropic` routes; Claude Code's model per query, on a
  resumed conversation); a model on **another engine** starts a new
  conversation, because neither engine can read the other's.
- **A switch in place costs one uncached turn.** A prompt cache belongs to
  one model and reasoning level; measured on both engines, the next request
  re-reads the whole conversation at the uncached rate, then caching resumes.
  Each engine reports the input its last model call read (`contextTokens()`
  in the engine contract), so the picker shows that size before a switch and
  the shell repeats it after one, with `/handoff` as the cheaper choice.
- **`/handoff`** starts a new conversation on the same model, for a fresh
  context. The earlier conversation's transcript is kept until the session
  closes (`retiredEngineIds`).
- **A new conversation is never blank.** Whenever the agent starts one in a
  session with history, for any reason, it receives with the next request a
  brief copied from Tesota's records (`src/handoff-brief.ts`): the operator's
  requests for the pending changes verbatim, the pending changes, the findings
  still open from their last review (read from the assurance journal, and
  marked when they reviewed an earlier state), and the previous agent's last
  reply, its end kept past 6,000 characters. The brief is marked as Tesota's
  and says it may be incomplete; it joins the request as Tesota context, so
  the request record stays the operator's own. The operator sees it whole
  before the agent does, and is told at the switch that the conversation does
  not carry over. That rule is `needsBrief`, proved beside `modelSwitch`.
- Commands are taken only at the request prompt, so a switch never lands in
  the middle of a turn. Review roles are unaffected: they read
  `tesota roles` when each review starts.

### The plan

For a request of three or more steps, the agent keeps a
**plan** with the `plan` tool (`src/integrations/plan-tool.ts`), as Claude
Code, Codex (`update_plan`) and OpenCode (`todowrite`) do: it sends every
step each time, each `pending`, `in_progress`, `done` or `blocked`, and may
say how a step's result can be checked. The shell shows the plan above the
prompt, saves it with the session and clears it when the work is kept,
reverted, applied or rejected; its tool calls stay out of the conversation. It is a Tesota tool,
so it works on every engine, and it keeps the plan out of the project's
files, where a `TODO.md` would end up in the diff.

**A plan is the agent's account, never evidence.** A step it marks done reads
"done (agent)", and a check it declares reads "will be checked" or, once the
step is done, "check not run", because nothing yet runs it
(`planLines` in `src/work-plan.ts`). An update is accepted only with one to
twenty steps, at most one in progress, and a reason for every blocked step,
and is refused whole otherwise; that rule is `planAccepted` in
`src/verification/plan-rule.ts`, proved by `bun run formal:check`. Steps stay
flat, as in every tool compared: nesting adds state the model must keep
consistent, which Pi's author gives as the reason Pi has no to-do list at
all.

The review checks each step the agent marked done against the result, with
the request obligations ([assurance](assurance.md#obligations)), and the plan
then shows what it found
of each: "held in review", "not held in review" or "review uncertain".
Planned: a step whose check is a gate shows "verified" when
that gate passes on the result.

### Proofs while it works

The `prove` tool (`src/integrations/prove-tool.ts`, issue
[#294](https://github.com/sequelcore/tesota/issues/294)) runs LemmaScript with
Dafny on one TypeScript file with `//@` annotations, with its `.dfy`
companion, and returns whether its contracts hold or which obligation fails.
It runs on a private copy, as Tesota's verifier does, so it changes no file
and needs no command approval. Its guidance tells the agent to work until the
proof passes, to change a contract only when the request asks for different
behavior and say so, and never to remove or loosen one, or add `//@ assume`,
to make a proof pass. LemmaScript's own loop and Midspiral's lemmafit put the
verifier inside the agent's work in the same way.

What the agent proves is feedback, never evidence: Tesota still proves the
candidate after the turn ([assurance](assurance.md)). A session gives the
agent `prove` and its guidance when the repository has a TypeScript file with
`//@` annotations outside dependency and build folders (`hasContracts`);
otherwise its prompt and tools are unchanged.

**Measured on 2026-10-02** with `live:agent --set=proofs`, six registered
cases, five runs each, in three arms: neither, the contract guidance alone
(`--proofs=guidance`), and `prove` with its guidance (`--proofs=tool`).
Every turn in every arm passed its hidden test; only the proof told them
apart.

| Model | Arm | Proved | Proved, invariant cases | Tokens per turn | Time per turn |
| --- | --- | --- | --- | --- | --- |
| `claude-2:sonnet` | neither | 16/30 | 1/15 | 12.3k | 5.1 s |
| | guidance | 30/30 | 15/15 | 12.7k | 5.8 s |
| | `prove` | 30/30 | 15/15 | 13.4k | 7.4 s |
| `codex-free2:gpt-6-luna` | neither | 15/30 | 0/15 | 8.0k | 10.2 s |
| | guidance | 23/30 | 8/15 | 7.7k | 10.9 s |
| | `prove` | 30/30 | 15/15 | 13.3k | 15.0 s |

Without either, both models fixed the code and left a loop invariant
missing, so the proof after the turn would fail and start a correction
round. The guidance alone was enough for Sonnet, which ran `prove` once per
case and passed each time; Luna needed the tool, running it about twice on
each invariant case and repairing the proof after the first failure. No
contract was weakened in any arm, but the cases did not tempt that, so the
measurement says nothing about weakening under pressure. GPT-6.1 Sol was not
measured: free ChatGPT accounts do not serve it, and the Plus account's
weekly limit was nearly spent. Whether the agent should add contracts to code
that has none is a separate question, not measured here.

## Explorers

With `explore`, the working agent asks a read-only **explorer** one question.
An explorer is a fresh Pi session with only the read-only file tools, confined
to the project: no shell, no network, no editing and no `explore` of its
own, so it never asks the operator anything and cannot start further
explorers. It sees the question, never the agent's conversation, and answers
with the files and lines it relied on and what it did not find. The agent is
told to treat the answer as a lead to check, not as fact.

| | Explorer | Reviewer |
| --- | --- | --- |
| Started by | The working agent, during its turn | Tesota, after the work |
| Sees | The agent's question and the checkout | The requests, the evidence and the checkout |
| Output | Advice to the agent | Findings that decide correction and inform the operator |

Explorers are bounded: at most three run at once and eight per request, each
has a five-minute limit and stops with its turn on `Esc`, and its answer is
cut at a fixed length. An unfinished or empty reply is never presented as an
answer, and the per-request allowance is a proved rule
(`src/verification/helper-answer.ts`). Each call shows in the conversation
with the explorer's reads as they happen and its time and tokens with its
answer. On Pi's routes each explorer's conversation is saved in the
session's `explorers` directory beside its record, where the agent cannot reach it; Claude
Code keeps no conversation for a read-only role.

**Explorers are off by default.** `bun run live:delegation` compares their
effect on accuracy, time and tokens before the default changes.

## The advisor

The advisor is a stronger model the working agent consults at hard decisions,
off until the operator chooses a model for it (`tesota roles advisor
<route:model>`), like explorers.

- **What it sees and can do.** As in Anthropic's advisor tool, it reads the
  agent's conversation, the operator's requests, every tool call and result
  and the agent's replies, and has **no tools**, so it changes nothing and
  nothing it reads can make it act. Each engine gives Tesota the conversation
  in one shape (`conversation()` in the engine contract): Pi from the
  messages it holds, Claude Code from the messages Tesota observes as they
  stream and, for a resumed conversation, those the SDK saved. Tesota renders
  it for the advisor (`src/integrations/advisor.ts`), cutting long tool
  results and, past 200,000 characters, keeping the first request and the
  newest entries with the omission stated. Any route can advise any other, so
  the advisor can come from another lab than the agent, as Amp pairs its
  Oracle.
- **When.** The agent calls `advisor`, optionally with a focused question.
  Its system prompt carries Anthropic's suggested timing for coding: after
  orienting and before substantive work, when the task seems complete, when
  stuck or changing approach; and how to weigh advice: follow it unless a step
  fails or the code contradicts it, and consult again rather than silently
  switch. Anthropic's harder "consult before the first write" rule is not
  used; Anthropic found it flat on mixed work.
- **Limits.** At most three consults a request (`canStartHelper` in
  `src/verification/helper-answer.ts`, the rule explorers use), one at a
  time, five minutes each, and the advisor is asked for under 150 words. An
  unfinished or empty reply is never passed as guidance (`isHelperAnswer`).
  Each consult shows in the conversation with its question, and its time and
  tokens come back with the guidance.
- **Advice is advice.** It never enters review evidence: the checks,
  reviewers and refuter judge the frozen candidate as before.

## Models by role

| Role | Sessions |
| --- | --- |
| `agent` | The working agent |
| `explorer` | Explorers; `off` until a model is chosen, which turns them on for sessions opened afterwards |
| `advisor` | The advisor; `off` until a model is chosen, likewise |
| `reviewer` | The reviewer, its lenses and ClaimCheck |
| `refuter` | The refuter |
| `validator` | The fix validator |
| `triage` | The answer check's first pass; it may also use Jev, a typed decision model, and `off` sends every answer to the full check |
| `namer` | Writes a short title for each new session from its first request; `codex:gpt-6-luna@low` by default, and `off` keeps the request as the name |
| `searcher` | Searches the web for the agent and explorers with its provider's own search; only Codex and Claude Code routes, and `off` leaves search to a SearXNG in `~/.tesota/web.json` |

Each role uses the model the operator chose in `~/.tesota/models.json`,
written as `route:model`, and `codex:gpt-6-luna`, the cheapest on the Codex
route, when there is no choice. `tesota roles` lists each role with its
model, who pays for it and the model's list price, and
`tesota roles <role> <route:model>` sets one from the models
the route offers, or `default` to clear it. An unreadable file is an error,
not a silent fallback. A role reads its model when it starts work, and review
measurements record the models so forecasts compare like with like.

### Reasoning levels

A choice may end in a reasoning level, `route:model@level` with `low`,
`medium`, `high`, `xhigh` or `max`, the levels both engines share: Pi's
thinking level and Claude Code's effort. `tesota roles` and `/model` accept
only a level the model takes on its route, from Pi's catalogue; through
Claude Code, only models Pi maps to effort levels take one, and an alias
takes its family's newest model's levels. Pi would otherwise lower an
unsupported level silently. Without a level, Pi's models reason at medium, as
they always have in Tesota, and Claude Code's at their model's default, which
for Opus 5.5 is medium. A `/model` switch on the same engine applies the new
level with the new model. The level is part of the choice, so review
measurements record it and forecasts compare like with like. Pi reports
reasoning tokens as output; the engines' own defaults are unchanged, since no
measurement yet shows a better level for any role.

### Judges and their authors

Several roles judge another's output: the reviewer, the
validator and the refuter judge the agent's work, the reviewer and validator
also judge work the advisor's guidance shaped, and the refuter tests the
reviewer's findings. Evaluators favor their own output even on objective code
criteria, and their own family less strongly. `tesota roles` lists every such
pair that shares a model,
as a warning, or a lab, as a note, and a choice or a `/model` switch that
creates one says so (`src/judge-warnings.ts`; the levels are
`judgeIndependence` in `src/verification/judge-independence.ts`, proved by
`bun run formal:check`). A Claude Code alias counts as the same model as the
models of its family, since it follows the newest of them. Tesota warns and
never refuses: an operator with one plan may have no other model, and with
two labs and more than two roles some pair must share a lab. When one must,
a refuter that shares the reviewer's lab errs toward keeping findings the
operator then sees, while one that shares the agent's lab errs toward
dismissing real defects.

## Model routes

A **route** is how Tesota reaches a model and whose account pays for it. Every
role can use any route.

| Route | Engine | Signed in by | Paid through |
| --- | --- | --- | --- |
| `codex` | Pi | `tesota auth login codex`: Pi's Codex OAuth, stored by Tesota | The operator's ChatGPT plan, against its limits |
| `anthropic` | Pi | `tesota auth login anthropic`: the operator's Anthropic API key, stored by Tesota, or `ANTHROPIC_API_KEY` | The API key, per token |
| `claude-code` | Claude Code, through the Claude Agent SDK | The operator, in Claude Code itself (`claude`, then `/login`) | Whatever Claude Code is signed in with, usually a Claude plan |
| `openrouter` | Pi | `tesota auth login openrouter`: OpenRouter's browser sign-in, which issues a key, or a pasted key, stored by Tesota; or `OPENROUTER_API_KEY` | The operator's OpenRouter credits, per token; `:free` models cost nothing |
| `opencode` | Pi | `tesota auth login opencode`: the operator's OpenCode key, stored by Tesota; or `OPENCODE_API_KEY` | The operator's OpenCode Zen balance, per token |
| `opencode-go` | Pi | The same OpenCode key | The operator's OpenCode Go subscription, against its limits |

Who pays is the route's (`ROUTE_BILLING`); a model's list price is the
catalogue's.

**Several accounts**. The table's routes are each a *kind's*
default route. A route is a kind and one account behind it: the kind
decides the engine, the models, who pays and each model's lab; the route
decides only the account. The operator adds routes of the `codex` and
`claude-code` kinds, the ones signed in to a plan, under names of their
own (`tesota auth login codex --as codex-work`, kept in
`~/.tesota/routes.json`), and gives a role one with the usual choice,
`codex-work:gpt-6-luna@low`, as t3code runs Codex and Claude as separate
instances. An added Codex route keeps its login in a file of its own
beside the default route's; an added Claude Code route has its own
configuration folder (`CLAUDE_CONFIG_DIR`), where the operator signs in
with Claude Code itself, so Tesota still holds no Claude login. Routes of
one kind are one lab to the judge warnings, and one model on two of them
is one model. A failed request names its route, since a lapsed plan fails
with only the model's refusal, as on 2026-09-29. `/model` continues in
place only on one account: another route's account needs its own runtime
or Claude Code process, so it starts a new conversation with the brief. A
route that a role uses is not removed until the roles choose another
(`routeAfter` in `src/verification/route-removal-rule.ts`, proved): signing
a route in again, to change its account, or out keeps the route and the
roles on it, and only `tesota auth remove` deletes one. Status names the
account each route is signed in to, from Claude Code's `.claude.json` or the
Codex token's profile claim, read locally, its email masked unless asked, and
names routes signed in to the same account, whose limits are one plan's
(`src/route-accounts.ts`). `tesota roles`, the Accounts panel's Roles tab
and a role choice that makes it so name roles on different routes that draw
on one account, since spreading roles across routes is meant to spread them
across plans; roles all on one route draw on one account by choice.

**What each account has left**. `tesota usage` and the
shell's Accounts panel ask each route's provider, only when run or opened,
and show a meter per window or credit: the share left in 20 segments, as
Codex's `/status` draws it, and when it resets. An account is read once,
through the first route signed in to it, and every route on it shows that
reading and names that route, so two meters of one plan cannot disagree
(`usageReader` in `src/verification/usage-reader-rule.ts`, proved); a route
whose account cannot be read is read by itself. Codex's windows come from `wham/usage`, the private
endpoint Codex's own client reads, with the route's token, which Pi
refreshes; Claude Code's from the Agent SDK's experimental usage report,
read without sending a request and with Claude Code's ordinary traffic on,
since a working session turns it off and the report then has no limits;
OpenRouter's from the key's limit; OpenCode Go's from its usage endpoint.
A window is labelled by its own length, so a free Codex account's 30-day
window is not taken for a week. The segment count is proved
(`src/verification/usage-meter-rule.ts`): a bar is empty only when nothing
is left and full only when nothing is used. Each reading is saved in
`~/.tesota/usage.json` with its time, and a failed read, often a usage
endpoint limiting its own requests, shows the last one of the past hour with
its age, as Claude Code's `/usage` does; after that the route is unknown.
The Anthropic API route, OpenCode Zen and TypeSafe offer no source for the
key Tesota holds, so they say where to look. No key or token is shown or
saved.

The Accounts panel (`/accounts`, `/usage`, `Alt+A`) is a framed overlay
over the whole layout, sidebar included, since accounts belong to no one
session, with a margin that leaves the layout showing beneath. It lies on
its theme's panel surface, a second neutral layer raised from the
terminal's, and while it is open the layout beneath is faded, its styles
removed and its text faint, as a web page dims behind a dialog; the shell's
TUI fades those lines before pi-tui draws the overlays over them. It has three
tabs, as Claude Code keeps `/status`, `/config` and `/usage` in one settings
dialog: Usage, the same table as `tesota usage`; Sign-ins, the
table of `tesota auth status`; and Roles, each role's model, its account and
that account's least-left window, where `Enter` opens the role's model
picker. Usage is state, not conversation, so nothing in the panel enters
the transcript, where it would go stale. The CLI and the panel draw from one
renderer each, the panel adding the theme's colors: an account turns to the
warning color at a quarter left and to the error color when nothing is
(proved in the same rule file). The panel shows the saved readings at once,
faded, and replaces each as it is read; it is as tall as its longest tab, so
switching tabs never moves it, and notes wrap under their column rather
than lose their links on a narrow terminal.

A list price is what an API key is billed, and on a plan only a
way to compare models, so `tesota models` shows both separately.

**Tesota never handles Claude subscription credentials.** On the
`claude-code` route, the unmodified Claude Code program bundled with the Agent
SDK signs in through Anthropic's own flow, and Tesota only starts it. The
credential store accepts nothing but an API key for `anthropic`, so Pi's own
claude.ai login, which presents itself as Claude Code, cannot be used through
Tesota.

**The gateways** serve many labs' models through Pi's own
providers. OpenRouter names a model `vendor/model`, with a `:variant` such
as `:free` (`openrouter:qwen/qwen3.8-27b:free`); only that route accepts the
slash and the variant. Tesota names itself to them, not Pi: OpenCode asks
every client for its own user agent and a stable `x-opencode-session` per
conversation, so the model carries `tesota/<version>` and
`x-opencode-client: tesota`, and Pi adds the session from the conversation's
id. Pi's install telemetry is off in Tesota's sessions, since it would list
Tesota's OpenRouter calls under Pi; Tesota sends no OpenRouter attribution of
its own, which would list it publicly in OpenRouter's rankings. That has a
cost: OpenRouter offers some free models only to agents in its app
directory (403 "only available on agentic harnesses", at the routing step
"Gate Free Endpoints by Agentic Harness"), so Tesota cannot use them. The
operator chose on 2026-09-26 to keep attribution off while Tesota is
pre-release, and to revisit it with the public launch; turning it on means
sending `HTTP-Referer` with a public Tesota address and `X-OpenRouter-Title`
from `identityHeaders` in `src/integrations/model-session.ts`.
`src/integrations/model-session.ts` owns these headers, and a test reads them
from the wire.

Not every catalogue model is offered. OpenRouter's `:batch` variants answer
within a day through its Batch API, too late for any role, and its routers
(`auto`, `openrouter/fusion`) bill the model they pick, so they are shown
without a price rather than as free. Zen's free models are not offered:
OpenCode refuses them to every client but its own, with 403 "OpenCode's free
tier can only be used from within OpenCode", which Zen's documentation does
not state. `tesota models` lists OpenRouter and Zen by count, and
`tesota models openrouter` lists every model with its price.

**A free model's provider may keep the repository's code.** OpenRouter's free
models' providers may log and train, and Meta's contributor models on Zen
and Go train on what they are sent. `dataNotice` in `src/models-command.ts` marks them; choosing
one, with `tesota roles` or `/model`, warns and never refuses, as for
judges. Paid models on these gateways keep nothing or 30 days by their
stated policies.

A judge's lab is the route's on `codex`, `anthropic` and
`claude-code`, OpenRouter's vendor, and the family an OpenCode model's id
starts with. The same model on another route is the same model
(`openrouter:anthropic/claude-opus-5.5` is `anthropic:claude-opus-5-5`); a
router, or a model whose family names no lab, has no known lab, and no
warning claims it independent or not.

### The engine contract

**Every engine holds a role to one contract**, owned by
`src/integrations/model-session-contract.ts`. Each clause is checked against
both engines by `tests/model-session-contract.test.ts`, Pi on its scripted
faux model and Claude Code through a double of its SDK, and against the real
engines by the opt-in live suite.

| Clause | Pi | Claude Code |
| --- | --- | --- |
| A session has exactly the tools it was given | Its tool list; none of Pi's built-in extensions (codemode, tool search, MCP), whatever the workspace's `.pi` folder asks for (`tests/pi-session-tools.test.ts`) | Built-in tools disabled, Tesota's tools from an in-process MCP server, and anything else refused |
| A tool that fails is reported as failed, whether it threw or returned an error result, as Pi's bash does for a command that fails | Pi's `isError` | The result's `isError`, passed on to Claude Code |
| A batch in which every tool asks to end the turn ends it, with no further model call | `terminate` on a tool result | A `PostToolBatch` hook answering `continue: false` |
| A request ends `completed`, `failed` with the engine's own message, `cancelled`, or `unsettled` when the engine cannot be stopped | Pi's session events | The SDK's result message |
| Tool activity and replies are reported as they happen | Pi's events | Tesota's tool wrappers and the SDK's messages |
| Tokens are reported as OpenTelemetry's GenAI conventions count them: `input` includes cached input, with cache reads and cache creation as parts of it | Pi's usage, cache added back into input | Claude Code's per-model usage, likewise |
| The working agent reads a message steered into its run before its next model call, in the same run (checked on Pi only) | Pi's steering queue, read whole; one that arrives as the agent finishes gets a model call of its own | Not offered: a query takes its one prompt when it starts, so the message is queued for the next request |

The failure message stays the engine's own, such as Pi's "You have hit your
ChatGPT usage limit": Pi classifies failures only by matching text, so a
Tesota-wide failure kind would copy those patterns, and nothing yet acts on
one.

A Claude Code session also loads none of the operator's Claude Code settings,
`CLAUDE.md`, hooks, skills or MCP servers, so a review is the same whoever
runs it, and runs with Claude Code's nonessential traffic off, which also
removes a background model call. Only the working agent's conversation is
saved, by Claude Code, and resumed on the next request; read-only roles keep
none.

**Time limits sit above each engine's own guards.** A review role's request
stops after ten minutes and an explorer's after five; a request the limit
stopped ends `timed_out`, never `failed` or `cancelled`, and a completed,
failed or unsettled request keeps its outcome. That rule is
`limitedTurnStatus` in `src/verification/turn-time-limit.ts`, proved by
`bun run formal:check`. Within the limit each engine guards its connections
and retries: Pi gives up on a connection that does not open in 15 seconds or
a stream quiet for five minutes and retries three times; Claude Code waits up
to 180 seconds for the first byte and five minutes for a quiet stream, and
retries ten times. Retried stalls can therefore last far longer than one
timer, which is what the limit bounds. The working agent has no limit: the
operator is present, and `Esc` stops it.

Forecasts and summaries compare token totals, and `live:review` records the
kinds, since a cache read costs a fraction of fresh input.

On `live:review`, Claude Sonnet through `claude-code` reviews as well as
Luna, in about 40 s of review against Luna's 64 to 72 s, and about 1.4 times
Luna's tokens, most of them cache reads. The `anthropic` route has not been
exercised live.

## Web access

The agent and explorers can search the web and read pages; reviewers, the
refuter and the fix validator stay offline, because a page could steer the step that decides
what reaches the operator, a finding based on a page cannot be checked
against the code, and a review must give the same verdict on the same
candidate later.

- **Tools** (`src/integrations/web-tools.ts`). `web_search` returns titles,
  addresses and snippets, or a searching model's findings with the pages
  they came from, and names who searched. The agent reads a page with `web_read`, giving an
  address and a question: Tesota fetches the page, and a fresh session with
  no tools, on the explorers' model when they are on and the agent's
  otherwise, receives its text and answers with quotes; the agent receives
  that answer, never the page. An explorer has `web_fetch`, which returns the
  page's text to itself, since an explorer cannot write or run commands. Page
  text therefore reaches only sessions that cannot act. The tools are
  Tesota's own, so every engine has the same ones.
- **Search** (`src/web-search.ts`) sits behind one seam with providers in
  order: a SearXNG instance the operator runs, named in
  `~/.tesota/web.json`, then `hosted`, the `searcher` role's model searching
  with its provider's own search, which needs no setup (issue #295). Without
  a pin, each available provider is tried until one answers, and a failure
  names every provider tried; `"search": "searxng"` or `"search": "hosted"`
  in `web.json` pins one, which is then the only one used, never replaced
  when unavailable and never followed by another when it fails
  (`searchStep` in `src/verification/search-provider-rule.ts`, proved by
  `bun run formal:check`). With no provider, or with an unreadable file,
  search reports `provider_not_configured`.
- **Hosted search** (`src/integrations/hosted-search.ts`) runs on the
  routes whose provider searches itself, Codex and Claude Code
  (`HOSTED_SEARCH_KINDS`); the Anthropic API's search has not been
  exercised. Its session has no Tesota tools, only the provider's search:
  Codex on Pi with the Responses `web_search` tool, Claude Code with
  `WebSearch` alone. The searcher answers with findings and their pages, so
  web content again reaches only a session that cannot act. Pi keeps only a
  response's text, so the Codex search reads the pages its search found or
  opened and its `url_citation`s from the provider's events
  (`onProviderStreamEvent`); Claude Code's `WebSearch` result lists its
  pages. A page the findings cite counts as a source only when the search
  found or opened it, compared without tracking parameters (`sourceKey`);
  the tool names the others as not confirmed. Findings are a lead: two live
  searches on 2026-10-02 gave one release two different years, so the agent
  reads a page with `web_read` before relying on it. Live, on the same
  question, Codex's `gpt-6-luna` took 5 s and about 9k tokens, and Claude
  Code's `haiku` 22 s and about 61k, most of them Claude Code's own prompt.
- **Authority.** A page is read only from a host the operator allowed: for
  the session, for the repository in the same list the sandbox's network uses
  (`host:443`), or when asked, with the same question and answers as a
  refused sandbox destination; a refusal is remembered for the session. The
  operator is asked **before** the host is looked up, because the lookup
  itself would reveal the name. The order (a readable URL, then permission,
  then a public address) is `webAdmission` in
  `src/verification/web-admission.ts`, proved by `bun run formal:check`.
- **Fetching** (`src/web-fetch.ts`) runs on the operator's machine, outside
  any sandbox, so it refuses what could reach the operator's own network:
  only `https` on the standard port (plain `http` is upgraded), no
  credentials in the URL, and every resolved address public by IANA's
  special-purpose ranges, IPv4 inside IPv6 included (`src/web-address.ts`).
  The connection goes to the address that was checked, while TLS still
  verifies the certificate for the host, so a public name cannot point
  inside. Each redirect is a new destination with the same checks, at most
  five. GET only, no cookies, 2 MB, 30 seconds, and only text: HTML converted
  to text, plain text, Markdown and JSON.
- **Failures are typed** and never read as an empty success: `url_refused`,
  `destination_denied`, `address_refused`, `too_many_redirects`, `too_large`,
  `unsupported_type`, `timeout`, `empty_page` and `fetch_failed` for pages,
  `provider_not_configured` and `provider_failed` for search.
- **Visible.** Each search and read shows in the conversation with its query
  or address. The reader's time and tokens come back to the agent with its
  answer, as an explorer's do.

Pages that block automated requests, such as npm's, and pages that build
their text with JavaScript give little or nothing; both engines' live runs
met them.

# Model access landscape (September 2026)

How a user without a ChatGPT or Claude plan could reach models through
Tesota: a Gemini API key, OpenRouter, and OpenCode's Zen and Go. Researched
on 2026-09-26 from each provider's terms and documentation linked below, Pi
0.87.1's catalogues and source, and OpenCode's source (`opencode` at
`b471c2b449`, 2026-09-26). It informed decision 031, which builds OpenRouter,
Zen and Go; the Gemini API was not chosen. Recheck terms and limits before
relying on them, since free offers change often.

## The options

| | Gemini API (Google AI Studio) | OpenRouter | OpenCode Zen | OpenCode Go |
| --- | --- | --- | --- | --- |
| What it is | Google's API for Gemini models | A gateway to hundreds of models from many providers | OpenCode's gateway of models "tested and verified" for coding agents ([Zen](https://opencode.ai/docs/zen/)) | A "low cost subscription for open coding models" ([Go](https://opencode.ai/docs/go/)) |
| Payment | None for a free-tier key ([rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)) | Credits bought ahead; free models need only an account | Pay as you go from a balance, with optional auto-reload of $20 below $5 | $10 a month |
| Free models | The free tier of Gemini models, with limits shown in AI Studio | Models with `:free` IDs: 22 in Pi's catalogue, and the `openrouter/free` router | Seven in Pi's catalogue, such as Big Pickle; OpenCode answers them only to its own client, refusing others with 403 "OpenCode's free tier can only be used from within OpenCode" (observed 2026-09-26, not documented) | None; past the monthly limit, Zen's free models remain |
| Limits | Per project, in AI Studio | Free models: 20 requests a minute; 50 a day with less than $10 of credit ever bought, 1,000 with $10 or more; 429 when exceeded, 402 when credits run out ([limits](https://openrouter.ai/docs/api/reference/limits)) | Not stated | Per model: a share of the month's allowance, at most 20% in five hours and 50% in a week |
| Use of your data | Free tier: "Google uses the content you submit … to provide, improve, and develop Google products" and "human reviewers may read, annotate, and process your API input and output"; not on paid services ([terms](https://ai.google.dev/gemini-api/terms), updated 2026-04-28) | OpenRouter "does not store your prompts or responses, unless you opt in", keeping metadata ([data collection](https://openrouter.ai/docs/guides/privacy/data-collection)); each provider has its own policy, and free models' providers may log and train ([provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging)) | Providers keep nothing, except OpenAI's and Anthropic's 30 days; Big Pickle's and MiMo's free trials may use data "to improve the model" | Most models: not used for training, kept 0 to 30 days; Meta's "contributor" Muse Spark models are cheaper because Meta may train on what they are sent |
| Other conditions | Users must be 18 or older; "for developers building with Google AI models for professional or business purposes, not for consumer use"; only paid services in the EEA, Switzerland and the UK | | Models hosted in the US | One subscriber per workspace; "traffic is monitored for abuse" |
| Use from other tools | An API key for building applications | An API key, or "Sign in with OpenRouter" (OAuth with PKCE), which issues a user-controlled key ([OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth)) | An API key, with "no lock-in" to OpenCode | An API key; "designed for OpenCode and other coding agents", with Pi among the validated clients |
| In Pi 0.87.1 | `google`, API key | `openrouter`, API key or OAuth | `opencode`, API key | `opencode-go`, the same key |

Zen and Go share one OpenCode account and one key: "You sign in to OpenCode
Zen, subscribe to Go, and copy your API key."

## What a client must send

**OpenCode Go asks every client** to "identify itself with its own user
agent, such as `my-coding-agent/1.0`, rather than a generic SDK or
HTTP-library name", and to "send a stable session ID in `x-opencode-session`
for each conversation so we can optimize routing and prompt caching". A
request without it is refused: Gentle AI recorded `400 {"type":
"MissingSessionID", "message": "Request is missing x-opencode-session and
cannot be routed efficiently."}` from a reviewer that called an OpenCode
model outside Pi's agent loop.

- **OpenCode itself** sends `x-opencode-session`, `x-opencode-request`,
  `x-opencode-client`, an optional `x-opencode-project` and its own user
  agent to its gateways (`packages/opencode/src/session/llm/request.ts`), and
  `HTTP-Referer: https://opencode.ai/` with `X-Title: opencode` to OpenRouter
  (`src/provider/provider.ts`).
- **Pi** adds `x-opencode-session` from the conversation's id and
  `x-opencode-client: pi` to OpenCode's gateways inside its agent loop, and
  its user agent is `pi (<platform> <release>; <arch>)`
  (`pi-coding-agent/dist/core/provider-attribution.js`,
  `pi-ai/dist/utils/pi-user-agent.js`). With its install telemetry on, the
  default, Pi also sends OpenRouter `HTTP-Referer: https://pi.dev`,
  `X-OpenRouter-Title: pi` and `X-OpenRouter-Categories: cli-agent`, which
  list the calls under Pi. Headers on the model override both.

**OpenRouter's app headers are optional.** `HTTP-Referer` is "the primary
identifier for rankings" and needed to create an app's public page;
`X-OpenRouter-Title` and `X-OpenRouter-Categories` only name and file it
([app attribution](https://openrouter.ai/docs/app-attribution)). Some free
models are nevertheless offered only to listed apps: on 2026-09-26
`thinkingmachines/inkling:free` answered a client without them with 403,
"only available on agentic harnesses. Try plugging it into a coding agent or
productivity app listed on https://openrouter.ai/apps", which the
documentation does not mention.

**OpenRouter's catalogue has models no role can use.** Its `:batch` variants
are the Batch API, which answers within 24 hours at about half the price
([Batch API](https://openrouter.ai/docs/batch-quickstart)). `auto` and
`openrouter/fusion` choose a model per request and bill that model, so
Pi's catalogue lists them at $0 though they are not free.

**A request can refuse providers that collect data**, with `"provider":
{"data_collection": "deny"}` or `"zdr": true` ([provider
selection](https://openrouter.ai/docs/guides/routing/provider-selection));
free models are free largely because their providers collect, so this would
remove most of them.

## What it implies for Tesota

1. **None needs a ChatGPT or Claude plan,** so each can reach users like a
   friend with only a Gemini consumer plan, which cannot itself be used
   outside Google's own tools. OpenRouter's free models need no payment at
   all; Go costs $10 a month for many open models.
2. **Free offers send the repository to providers that may train on it and,
   for Gemini, to human reviewers.** A user must be told this before a free
   model reads a private repository, and a paid model should be one step
   away.
3. **Limits decide usability for an agent.** A request makes many model
   calls; OpenRouter's 50 free requests a day may end within one request, so
   a limit should be reported clearly rather than fail as an unexplained
   error.
4. **Quality is unmeasured.** Free models' ability to act as Tesota's agent,
   reviewer or refuter is unknown; each needs a run on Tesota's evaluation
   cases before a guide recommends it, and review should stay on the
   strongest model available.
5. **OpenRouter's browser sign-in is the least friction,** closest to
   "install and ready", and Pi implements it. All three fit Pi as routes, as
   `anthropic` does, with the key stored by Tesota. Tesota must name itself,
   not Pi, on OpenCode's gateways, and must keep Pi's attribution from
   listing its OpenRouter calls under Pi.

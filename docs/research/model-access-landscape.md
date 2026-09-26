# Model access landscape (September 2026)

How a user without a ChatGPT or Claude plan could reach models through
Tesota: a Gemini API key, OpenRouter and OpenCode Zen. Researched on
2026-09-26 from each provider's terms and documentation linked below and Pi
0.87.1's catalogues; it informs a future route decision. Recheck terms and
limits before relying on them, since free offers change often.

## The options

| | Gemini API (Google AI Studio) | OpenRouter | OpenCode Zen |
| --- | --- | --- | --- |
| What it is | Google's API for Gemini models | A gateway to hundreds of models from many providers | OpenCode's gateway of models "tested" for coding agents |
| Subscription | None; a free-tier key needs no billing ([rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)) | None; free models need an account | An account; its setup asks for billing details, and free models are not charged ([Zen](https://opencode.ai/docs/zen/)) |
| Free models | The free tier of Gemini models, with limits shown in AI Studio | Models with `:free` IDs: 22 in Pi's catalogue | Seven in Pi's catalogue, such as Big Pickle, offered "for a limited time" |
| Free limits | Per project, in AI Studio | 20 requests a minute; 50 a day with less than $10 of credit bought, 1,000 a day with $10 or more ([limits](https://openrouter.ai/docs/api/reference/limits)) | Not stated |
| Use of your data on the free offer | "Google uses the content you submit … to provide, improve, and develop Google products" and "human reviewers may read, annotate, and process your API input and output"; not on paid services ([terms](https://ai.google.dev/gemini-api/terms), updated 2026-04-28) | OpenRouter does not train on prompts; some free providers log and may train, and an account setting can exclude providers that train ([provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging)) | Varies by model: some free models may use data to improve the model, one keeps nothing |
| Other conditions | Users must be 18 or older; "for developers building with Google AI models for professional or business purposes, not for consumer use"; only paid services for users in the EEA, Switzerland and the UK | | |
| Use from other tools | An API key for building applications | An API key or "Sign in with OpenRouter" (OAuth) | Documented API endpoints and a key |
| In Pi | `google`, API key | `openrouter`, API key or OAuth | `opencode`, API key |

## What it implies for Tesota

1. **None needs a subscription,** so each can reach users like a friend with
   only a Gemini consumer plan, which cannot itself be used outside Google's
   own tools.
2. **Free offers send the repository to providers that may train on it and,
   for Gemini, to human reviewers.** A user must be told this before a free
   route reads a private repository, and a paid key or opted-out settings
   should be one step away.
3. **Limits decide usability for an agent.** A request makes many model
   calls; OpenRouter's 50 free requests a day may end within one request, so
   the route should say what it allows and report a limit clearly rather than
   fail as an error.
4. **Quality is unmeasured.** Free models' ability to act as Tesota's agent,
   reviewer or refuter is unknown; each needs a run on Tesota's evaluation
   cases before a setup guide recommends it, and review should stay on the
   strongest model available.
5. **OpenRouter's browser sign-in is the least friction,** closest to "install
   and ready"; the Gemini key reaches Google's newest models; Zen's free list
   is curated for coding but temporary. All three fit Pi as routes, as
   `anthropic` does, with the key stored by Tesota.

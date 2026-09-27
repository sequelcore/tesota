# Authentication

Tesota reaches models through these routes ([design](../design/agents.md#model-routes)),
each signed in its own way:

| Route | Sign in | Stored by |
| --- | --- | --- |
| `codex` | `tesota auth login codex`: Pi's Codex OAuth | Tesota, in `~/.tesota/auth/codex.json` |
| `anthropic` | `tesota auth login anthropic`: your Anthropic API key, typed without being shown | Tesota, in `~/.tesota/auth/anthropic.json`; `ANTHROPIC_API_KEY` also works |
| `claude-code` | `tesota auth login claude-code`: Claude Code's own sign-in, the same as `claude auth login` | Claude Code, never Tesota |
| `openrouter` | `tesota auth login openrouter`: sign in with OpenRouter in your browser, or paste a key you have | Tesota, in `~/.tesota/auth/openrouter.json`; `OPENROUTER_API_KEY` also works |
| `opencode`, `opencode-go` | `tesota auth login opencode`: your OpenCode key, from [opencode.ai/auth](https://opencode.ai/auth), which serves both Zen and Go | Tesota, in `~/.tesota/auth/opencode.json`; `OPENCODE_API_KEY` also works |
| `typesafe`, for the `triage` role only | `tesota auth login typesafe`: your TypeSafe key, from [console.typesafe.ai](https://console.typesafe.ai) | Tesota, in `~/.tesota/auth/typesafe.json`; `TYPESAFE_API_KEY` also works |

In an interactive terminal, `tesota auth login` and `tesota auth logout`
offer a route selector. `tesota auth status` defaults to `codex`. For
`claude-code`, status shows only whether Claude Code is signed in and how,
and Tesota does not sign it out,
because that would also sign out your own Claude Code; use `claude auth
logout` for that. Tesota never reads, copies or stores a Claude subscription
login, and never accepts one for the `anthropic` route. Tesota does not read or
copy the credential stores of Codex, Pi or Kiln.

Usage on the `claude-code` route draws on your Claude plan's limits, the same
pool as your own Claude Code; the `anthropic` route is billed to the API key,
`openrouter` to your OpenRouter credits, `opencode` to your Zen balance, and
`opencode-go` counts against your Go subscription's limits.

## OpenRouter

`tesota auth login openrouter` opens OpenRouter's own sign-in page in your
browser, which returns to a server Tesota runs on this computer for the
sign-in; OpenRouter then issues a key that belongs to your account, and
Tesota saves it. If the browser is on another computer, paste the address
it ended on when Tesota asks. Tesota shows only OpenRouter's sign-in
address, and refuses to continue with any other. The key lasts until you
revoke it at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys);
`tesota auth logout openrouter` removes Tesota's copy without revoking it.
Answer `k` to paste a key you already have instead.

Free models need no credits. OpenRouter allows 20 requests a minute and 50 a
day until you have bought $10 of credit in total, then 1,000 a day, counted
for the whole account, whichever of its keys is used; one
request to the agent, with its review, makes many model calls. A free model
can also be refused for a while when its shared provider is busy (429, "temporarily
rate-limited upstream"). Their providers may keep your prompts and code and
train on them: `tesota models openrouter` marks them, and choosing one warns
you.

## OpenCode

`tesota auth login opencode` saves one key from
[opencode.ai/auth](https://opencode.ai/auth) for both Zen and Go; a key with
**Inference only** permission is enough. Zen's models need a positive Zen
balance, and Go's an active Go subscription in the workspace where the key
was created. Zen's free models, such as Big Pickle, are not offered: OpenCode
lets only its own app use them, and refuses other tools with "OpenCode's free
tier can only be used from within OpenCode".

## Codex

Pi refreshes expiring Codex credentials when they are used. `bun run
auth:codex` is also a login command. Login requires an interactive,
unrecorded terminal once: enter the temporary code only on the official website
shown by Tesota, using the intended account. It performs no model inference.
An existing saved login is retained; use logout before deliberately changing
accounts. A TTY check cannot detect terminal recording.

Login stops after three minutes, and cancelling it stops it at once; a code
that arrives after that is never shown. Login fails if anything tries to call
a model during it, even if that attempt is caught.

Status is offline and prints only whether a saved login exists. It does not
refresh tokens, identify the account or establish model access. Logout removes
Tesota's local credential only; it does not revoke the provider session or stop
an already running request. It does not affect other applications' logins.

After login, sessions and evaluations reuse the stored credential without a
terminal or another browser interaction. Missing credentials fail with login
guidance. Refresh failure does not fall back to another account, API key or
login method. Resolve the failure before explicitly logging out and logging
in again.

## Storage and concurrency

[TesotaCredentials](../../src/integrations/tesota-credentials.ts) implements Pi's
public `CredentialStore` contract for `openai-codex`, which holds only an OAuth
login; `anthropic`, which holds only an API key; `openrouter`, which holds a
pasted key or the key its sign-in issued, which Pi keeps as an OAuth
credential without a refresh token; and `opencode` and `opencode-go`, which
share one file holding one API key. Pi owns authorization, polling, token
exchange and refresh; Tesota owns storage and presentation.

Credentials are JSON protected by filesystem permissions, not encryption at rest.
On Windows, storage checks the directory owner and restricts its ACL to that user.
When an elevated process creates a new directory with an administrative default
owner, Tesota assigns that newly created directory to the current user before
locking its ACL; it never takes ownership of a pre-existing directory.
On Unix, the directory must belong to the current user with mode 0700, and files
use mode 0600. Applications running as the same user can access this storage.
Credential contents, raw provider failures and temporary codes are excluded from
routine output and recorded evidence.

Mutation uses an exclusive lock file shared across processes. Pi performs refresh
inside that lock and rechecks the current credential, preventing simultaneous
refresh of the same rotated token. Logout uses the same lock. New bytes are written
to a private temporary file, flushed and renamed before the lock is released.
Failed operations preserve the previous credential where replacement has not
completed. This is not a power-loss or distributed-filesystem guarantee.

Lock acquisition waits at most ten seconds and respects cancellation. A killed
process can leave `codex.lock`. Tesota does not steal an apparently stale lock.
Before removing it, establish that no Tesota process is active. A provider-side refresh followed by a failed local save can require
login again; local locking cannot roll back a remote token rotation.

Corrupt, oversized, foreign-provider or inaccessible records fail closed. A
saved login does not grant verification authority, model entitlement or human
acceptance. [Login](../../src/integrations/codex-login.ts) owns the device-code
flow and OpenRouter's sign-in; [storage](../../src/integrations/tesota-credentials.ts)
owns the files.

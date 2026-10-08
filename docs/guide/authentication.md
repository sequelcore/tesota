# Authentication

Tesota reaches models through these routes ([design](../design/agents.md#model-routes)),
each signed in its own way:

| Route | Sign in | Stored by |
| --- | --- | --- |
| `chatgpt` | `tesota auth login chatgpt`: Sign in with ChatGPT in your browser | Tesota, in `~/.tesota/auth/chatgpt.json` |
| `anthropic` | `tesota auth login anthropic`: your Anthropic API key, typed without being shown | Tesota, in `~/.tesota/auth/anthropic.json`; `ANTHROPIC_API_KEY` also works |
| `claude-code` | `tesota auth login claude-code`: Claude Code's own sign-in, the same as `claude auth login` | Claude Code, never Tesota |
| `openrouter` | `tesota auth login openrouter`: sign in with OpenRouter in your browser, or paste a key you have | Tesota, in `~/.tesota/auth/openrouter.json`; `OPENROUTER_API_KEY` also works |
| `opencode`, `opencode-go` | `tesota auth login opencode`: your OpenCode key, from [opencode.ai/auth](https://opencode.ai/auth), which serves both Zen and Go | Tesota, in `~/.tesota/auth/opencode.json`; `OPENCODE_API_KEY` also works |
| `typesafe`, for the `triage` role only | `tesota auth login typesafe`: your TypeSafe key, from [console.typesafe.ai](https://console.typesafe.ai) | Tesota, in `~/.tesota/auth/typesafe.json`; `TYPESAFE_API_KEY` also works |

In an interactive terminal, `tesota auth login` and `tesota auth logout`
offer a route selector. `tesota auth status` shows every route in one table,
or one route when you name it. For
`claude-code`, status shows only whether Claude Code is signed in and how,
and Tesota does not sign it out,
because that would also sign out your own Claude Code; use `claude auth
logout` for that. Tesota never reads, copies or stores a Claude subscription
login, and never accepts one for the `anthropic` route. Tesota does not read or
copy the credential stores of Codex, Pi or Kiln.

Usage on the `chatgpt` route counts against your ChatGPT plan's limits, and
on the `claude-code` route against your Claude plan's, the same pool as your
own Claude Code; the `anthropic` route is billed to the API key,
`openrouter` to your OpenRouter credits, `opencode` to your Zen balance, and
`opencode-go` counts against your Go subscription's limits.

The `claude-code` route runs the unmodified Claude Code bundled with Tesota,
signed in with your own Claude plan, as Anthropic's terms allow. The plan's
limits assume ordinary individual use; for heavy, unattended or shared use,
use the `anthropic` route with an API key
([decision](../decisions/claude-code-route-terms.md)).

## How much each account has left

`tesota usage` asks each provider how much every route has left and when it
resets; name a route to read only that one, as in `tesota usage chatgpt-work`.
Inside a session, `/usage` opens the same table in the Accounts panel
([using Tesota](using-tesota.md#accounts)).

```text
Route        Account          Window     Left                       Details
chatgpt      ChatGPT plus     5h         ████████████████████ 100%  resets in 3h 7m
                              week       █████████████░░░░░░░  67%  resets in 6d 1h
claude-2     Claude Code pro  5h         ████████████████████ 100%
                              week       ░░░░░░░░░░░░░░░░░░░░   0%  resets in 1d 9h
openrouter   OpenRouter       key limit  ████████████░░░░░░░░  61%  $2.45 of $4.00 left
typesafe     TypeSafe         no usage source: see console.typesafe.ai/settings/billing
```

A bar is the share **left**, empty only when nothing is. Windows are named by
their length, so a free ChatGPT account shows its 30-day window. An OpenRouter
key with a limit shows what remains of it; one without a limit shows what it
has used. OpenCode shows its Go subscription's windows. The Anthropic API
route, OpenCode Zen and TypeSafe have no usage source for the key Tesota
holds, so the table says where to look instead. Routes signed in to the same
account share one plan, so that account is read once: the first route shows
its meters and the others say `same account as <route>: one reading, above`.

ChatGPT's usage comes from a private ChatGPT endpoint, the one Codex reads, and
Claude Code's from an experimental report, so either may stop working. When a read fails, the table
shows that route's last reading from the past hour with its age; after an
hour it says `unknown` with the reason. Readings are saved in
`~/.tesota/usage.json` without any key or token.

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

## ChatGPT

`tesota auth login chatgpt` opens OpenAI's Sign in with ChatGPT page in your
browser, which names Tesota and returns to a server Tesota runs on this
computer for the sign-in. If the browser is on another computer, paste the
address it ended on when Tesota asks. Tesota shows only OpenAI's sign-in
address, and refuses to continue with any other. Each sign-in registers its
own client with OpenAI, and Tesota sends OpenAI this installation's id, kept
in `~/.tesota/auth/device-id`. The route signs in only this way: an
`OPENAI_API_KEY` in the environment is never used for it. `bun run
auth:chatgpt` is also a login command. Logging in again on a signed-in route
signs in afresh, as to change accounts; the earlier login stays until the new
one completes. Pi refreshes an expiring login when it is used.

The route offers the models a ChatGPT plan serves, not the rest of OpenAI's
API catalog. Login stops after three minutes, and cancelling it stops it at
once. Login fails if anything tries to call a model during it, even if that
attempt is caught.

Status is offline and prints whether a saved login exists and the account it
is for, read from the saved login's own claims, its email masked unless you
ask with `--show-accounts`. It does not refresh tokens or establish model
access. Logout removes
Tesota's local credential only; it does not revoke the provider session or stop
an already running request. It does not affect other applications' logins.

After login, sessions and evaluations reuse the stored credential without a
terminal or another browser interaction. Missing credentials fail with login
guidance. Refresh failure does not fall back to another account, API key or
login method. Resolve the failure before explicitly logging out and logging
in again.

## Storage and concurrency

[TesotaCredentials](../../src/integrations/tesota-credentials.ts) implements Pi's
public `CredentialStore` contract for `openai`, which holds only a Sign in with
ChatGPT login; `anthropic`, which holds only an API key; `openrouter`, which holds a
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
process can leave `chatgpt.lock`. Tesota does not steal an apparently stale lock.
Before removing it, establish that no Tesota process is active. A provider-side refresh followed by a failed local save can require
login again; local locking cannot roll back a remote token rotation.

Corrupt, oversized, foreign-provider or inaccessible records fail closed. A
saved login does not grant verification authority, model entitlement or human
acceptance. [Login](../../src/integrations/pi-login.ts) owns Sign in with
ChatGPT and OpenRouter's sign-in; [storage](../../src/integrations/tesota-credentials.ts)
owns the files.

# Authentication

Tesota reaches models through three routes ([design](../design/agents.md#model-routes)),
each signed in its own way:

| Route | Sign in | Stored by |
| --- | --- | --- |
| `codex` | `tesota auth login`: Pi's Codex OAuth | Tesota, in `~/.tesota/auth/codex.json` |
| `anthropic` | `tesota auth login anthropic`: your Anthropic API key, typed without being shown | Tesota, in `~/.tesota/auth/anthropic.json`; `ANTHROPIC_API_KEY` also works |
| `claude-code` | `tesota auth login claude-code`: Claude Code's own sign-in, the same as `claude auth login` | Claude Code, never Tesota |

`tesota auth status [route]` and `tesota auth logout [route]` work the same
way; without a route they mean `codex`. For `claude-code`, status shows only
whether Claude Code is signed in and how, and Tesota does not sign it out,
because that would also sign out your own Claude Code; use `claude auth
logout` for that. Tesota never reads, copies or stores a Claude subscription
login, and never accepts one for the `anthropic` route. Tesota does not read or
copy the credential stores of Codex, Pi or Kiln.

Usage on the `claude-code` route draws on your Claude plan's limits, the same
pool as your own Claude Code; the `anthropic` route is billed to the API key.

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
login, and `anthropic`, which holds only an API key. Pi owns authorization,
polling, token exchange and refresh; Tesota owns storage and presentation.

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
flow; [storage](../../src/integrations/tesota-credentials.ts) owns the files.

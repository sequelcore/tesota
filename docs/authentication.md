# Authentication

Tesota uses Pi's Codex OAuth implementation. Login is saved for later runs in
`~/.tesota/auth/codex.json`; Pi refreshes expiring credentials when they are used.
Tesota does not read or copy the credential stores of Codex, Pi or Kiln.

## Commands

Build with `bun run build`. From the repository root:

```sh
bun start auth login
bun start auth status
bun start auth logout
```

`bun run auth:codex` is also a login command. Login requires an interactive,
unrecorded terminal once: enter the temporary code only on the official website
shown by Tesota, using the intended account. It performs no model inference.
An existing saved login is retained; use logout before deliberately changing
accounts. A TTY check cannot detect terminal recording.

Status is offline and prints only whether a saved login exists. It does not
refresh tokens, identify the account or establish model access. Logout removes
Tesota's local credential only; it does not revoke the provider session or stop
an already running request. It does not affect other applications' logins.

After login, `bun run live:codex` reuses stored credentials without a terminal
or another browser interaction. Missing credentials fail with login guidance.
Refresh failure does not fall back to another account, API key or login method.
Resolve the failure before explicitly logging out and logging in again.

## Storage and concurrency

[CodexCredentials](../src/integrations/codex-credentials.ts) implements Pi's
public `CredentialStore` contract for `openai-codex` only. Pi owns authorization,
polling, token exchange and refresh; Tesota owns storage and presentation.

Credentials are JSON protected by filesystem permissions, not encryption at rest.
On Windows, storage checks the directory owner and restricts its ACL to that user.
When an elevated process creates a new directory with an administrative default
owner, Tesota assigns that newly created directory to the current user before
locking its ACL; it never takes ownership of a pre-existing directory.
On Unix, the directory must belong to the current user with mode 0700, and files
use mode 0600. Applications running as the same user can access this storage.
Credential contents, raw provider failures and temporary codes are excluded from
routine output and experiment evidence.

Mutation uses an exclusive lock file shared across processes. Pi performs refresh
inside that lock and rechecks the current credential, preventing simultaneous
refresh of the same rotated token. Logout uses the same lock. New bytes are written
to a private temporary file, flushed and renamed before the lock is released.
Failed operations preserve the previous credential where replacement has not
completed. This is not a power-loss or distributed-filesystem guarantee.

Lock acquisition waits at most ten seconds and respects cancellation. A killed
process can leave `codex.lock`. Tesota does not steal an apparently stale lock.
Before removing it, establish that no Tesota authentication or experiment process
is active. A provider-side refresh followed by a failed local save can require
login again; local locking cannot roll back a remote token rotation.

Corrupt, oversized, foreign-provider or inaccessible records fail closed.
The live experiment retains its own deadlines and invocation limits; saved login
does not grant verification authority, model entitlement or human acceptance.

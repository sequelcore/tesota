# Changelog

Each release of Tesota, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions before
the first stable release are prereleases. Numbers in parentheses are pull
requests and issues in [sequelcore/tesota](https://github.com/sequelcore/tesota).

## [0.1.0-alpha.5] - Unreleased

### Added

- `tesota doctor` reports which verification tools and model providers are
  ready, read-only. Git, Dafny with LemmaScript, and Java with TLC are core;
  Quint and each provider are optional, and at least one usable model
  provider is required. Each row gives the path, the version, what is lost
  without it and how to install it. `--json` gives the same report, and the
  exit code is 2 only when something core is missing (#694, #687).

### Changed

- A follow-up after a request whose changes were never verified, such as
  one stopped by an error or a limit, is judged against those earlier
  requests too, whatever its wording. The receipt records which requests
  each judgment received, and which, if any, did not fit the model's
  context (#693, #627).

### Fixed

- The floor no longer reads a home subfolder built with `Join-Path`, such
  as `Join-Path $env:USERPROFILE '.tesota\sessions\x'`, as the home folder
  itself. Nested joins, and Windows names made only of dots and spaces,
  still count as home (#692, #633).

## [0.1.0-alpha.4] - 2026-10-26

### Added

- The shell has a new look. The input is a full-width band, and so are your
  messages in the conversation. The shell opens with a compact header, 11
  columns by 3 rows (#678).
- Tesota's mark is redrawn as *Olneya tesota*, the desert ironwood, with a
  saguaro seedling. It blooms only when a request is verified, the same rule
  the receipt's text follows. Nothing moves while the agent works, and
  without color only its silhouette shows (#671).
- Every list marks its selected row with a full-width band: slash commands,
  pickers and questions (#673).
- `/usage` shows how much each account has left: a meter per limit window,
  when it resets, and warning colors. It opens at once on saved readings
  and marks the account the session draws on. `/accounts` opens the same
  dialog on its Accounts tab, to sign in again or remove an account (#677).
- Claude's limits come from Claude Code's own report; Tesota never reads
  Claude Code's credentials. ChatGPT's come from the Codex sign-in. The
  newer OpenAI sign-in doesn't report them, and the panel says so (#677).
- When TLC checks a TLA+ model, Tesota keeps the model graph it explored,
  from the same run that produced the evidence. The transcript previews it.
  `/graph` opens it full-screen, grouped by variables, with every broken
  rule marked and the failing run as the only real execution (#592, #593).
- `o` in `/graph` opens the same graph in your browser, as one
  self-contained HTML file beside the session, with no server and no
  network. The page names what went wrong in plain words, with the broken
  rule's own text from the model, generated from TLC's data (#662, #665).
- When an agent asks you something in `tesota -p`, the run says how to
  answer: `tesota -p --resume <id> "<answer>"`, or `-c` for the latest
  session. The same request continues from the same base, and your answer
  is recorded as a clarification, never as permission (#651).
- Several accounts per provider. Choose a session's account like a model,
  `claude-code@<name>/…` or `openai-codex@<name>/…`, and sign one in with
  `tesota accounts add` (#636, #642).
- When a test edit may weaken evidence, the receipt says how: a loosened
  assertion, a skipped test, or a new mock of the code under test (#646).
- One block per request: a live view while the agent works, which becomes
  the receipt. The running check shows its command and elapsed time (#591,
  #616).
- A scratch folder per session, named in the agent's instructions, for
  temporary files (#653).

### Changed

- A run ends `Completed, verified` only when a check passed, every changed
  file is proved or tested and exercised, and nothing is missing. Otherwise
  it ends `incomplete`, `unverified`, or plain `Completed` when nothing
  changed, and the receipt's summary agrees with it (#668).
- An agent's unanswered question ends the run as incomplete, and what
  changed is still verified (#599).
- Evidence whose file changed before the receipt reads as stale, not as
  passed (#617).
- A stopped run gets an inventory of what changed. A run whose process died
  is recorded as interrupted (#599).
- A request is credited only for its own commits when the history moves
  under it (#599).
- A receipt made from source names its commit, as
  `0.1.0-alpha.4+<commit>` (#639).
- A test runner's pass counts only when a target test ran (#615).

### Fixed

- Signing in with a browser works on Windows: the sign-in page opens on its
  own, its link is shown whole and `c` copies it, and Tesota says when the
  browser didn't open (#676).
- A resumed headless run continues on the model and account it last ran
  on. `--model` still overrides it, and says so (#675).
- Floor refusals are held to their effect and listed at the end of the
  request (#622).
- A writing subagent is kept off every branch but its own (#619).
- A read-only session verifies nothing (#585).
- A test is no longer credited because the base lacks an ignored file, and
  judging one test file no longer runs others whose paths end the same way
  (#618, #620).
- A stopped run no longer leaves a Git process running (#648).
- A session whose model sent malformed edit arguments resumes again (#657).
- Multi-line text pasted into a question keeps its line breaks as spaces
  (#624).
- `/resume` reopens a session that worked in the folder's checkout (#625).
- A request like "continue" is judged by open cases and ClaimCheck against
  earlier requests whose changes were never verified, back to the last
  successful verifier settlement with a non-stopped receipt. A tool-free
  completed answer does not discard them. The receipt stores which requests
  each judge received and names any left out for model context capacity
  (#627).

## [0.1.0-alpha.3] - 2026-10-23

### Added

- The shell shows queued messages, and you can edit them before they're
  sent (#611).

### Changed

- A test is judged on the base by its runner on that file alone, which
  makes verification faster (#609).
- Open cases report a missing reference instead of guessing (#594).
- A design model written with its code isn't called stale once it passed
  (#605).
- Unused Effect code stays out of the shell's startup (#598).

### Fixed

- Every row of a question can be reached with the arrow keys (#610).
- The agent's commands run in `sh` where bash is missing (#608).
- A package's test runner is picked without assuming npm (#604).
- Tests are credited despite base failures unrelated to them (#596).
- A Windows lock failure with no error code is treated as contention
  (#601).
- Test edits that only add arguments aren't flagged as weakening (#589).

## [0.1.0-alpha.2] - 2026-10-22

### Added

- A turning orb shows while the agent works (#587).

### Fixed

- Claude Code runs in the session's folder (#583).
- A test added to a Bun project with no tests is credited (#580).
- The terminal's query reply no longer stays at the prompt on exit (#578).

## [0.1.0-alpha.1] - 2026-10-22

The first published prerelease.

### Added

- Prebuilt binaries for Linux (glibc and musl), macOS and Windows, which
  verify without a checkout, published as a GitHub prerelease with
  checksums and provenance attestations, and installed by `install.sh` and
  `install.ps1` (#474, #573).
- Claude through your own Claude Code, for a Claude plan (#569).
- TLA+ and Quint design models checked with TLC during verification, and a
  `check_model` tool the agent uses while it works (#553, #555).
- Subagents, run as jobs of the run, each with its own receipt (#552).
- The agent can ask you questions, in the input's place (#511, #529).
- `ls`, `find` and `grep` tools on a bundled, pinned ripgrep (#517).
- Permission prompts with numbered choices (#515).
- Skills started by name (#549).
- Shared instructions from `~/.agents/AGENTS.md` (#572).
- Slash command and file suggestions in the shell's input (#505, #509).

### Changed

- Only what changed during a request is verified, and only when something
  that may change files ran (#514, #518).
- The receipt separates a test's provenance from its sensitivity (#530).
- Only models the sign-in serves are offered, and a subagent starts only on
  one of them (#565, #567).

### Fixed

- Every process a run started is stopped on Windows, whatever its parents
  (#492).
- One folder's snapshots are taken one at a time across processes (#477).

[0.1.0-alpha.5]: https://github.com/sequelcore/tesota/compare/v0.1.0-alpha.4...dev
[0.1.0-alpha.4]: https://github.com/sequelcore/tesota/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/sequelcore/tesota/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/sequelcore/tesota/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/sequelcore/tesota/releases/tag/v0.1.0-alpha.1

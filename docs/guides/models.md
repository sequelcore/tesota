# Models

Tesota reaches models through [pi-ai](https://github.com/earendil-works/pi)'s
providers: OpenAI, Google, OpenRouter, Mistral, xAI, Amazon Bedrock, Azure
and about thirty more.

## Sign in

```text
/login
```

Pick a provider. Some sign in with your account in the browser; others
take an API key, which you paste without it showing. When a provider
offers both, Tesota asks which. Sign-ins are kept in `~/.tesota/auth.json`,
readable only by you, and no tool call may touch that file.

An API key in the environment works without `/login`, such as
`OPENAI_API_KEY` or `OPENROUTER_API_KEY`.

`/logout` forgets a provider's sign-in.

### Claude through Claude Code

On a Claude plan, Tesota runs Claude through your own Claude Code,
unmodified. A release binary runs the `claude` on your `PATH`, so
[install Claude Code](https://code.claude.com/docs/en/setup) first; from
source, Tesota runs the program the Claude Agent SDK installs with it, and
`claude` on your `PATH` only when that one is missing. Sign in there, not in
Tesota: run `claude`, then `/login`. Tesota never sees your Claude
sign-in. Once you are signed in, `/model` lists Anthropic's models as
`claude-code/<id>`, such as `claude-code/claude-sonnet-5-5`. Until then it
says how to sign in.

Claude Code only answers. Tesota's tools, permissions, hooks, compaction and
verification run as on any model, and none of your Claude Code settings,
`CLAUDE.md`, skills or MCP servers load. Claude Code runs in the session's
folder, including its worktree. Tesota removes the Claude Code transcripts
it creates when the query ends, and their project folder only if it is empty.
Usage draws on your plan's limits,
which assume ordinary individual use; shared or heavy use belongs on an
`anthropic` API key. Why this route fits Anthropic's terms is in
[the decision record](../decisions/claude-code-route-terms.md).

## Choose a model

```text
/model
```

lists the models of every provider you can use. Your choice is saved, and
each new session starts with it. `tesota -p "…" --model openai/gpt-6-sol`
picks one for a single run. Tesota never picks a model for you: until you
choose one, the shell's status says so, and `-p` stops and says how.

Signed in with ChatGPT, OpenAI serves only some of its models to your plan.
`/model` lists only those, and a saved or `--model` choice outside them is
refused before any request, naming the ones you can use. When that list
can't be fetched, such as offline, your choice is kept and Tesota says it
wasn't checked; OpenAI still refuses a model it doesn't serve.

## Several accounts of one provider

Add each account in one step, with its provider and a name of yours:

```sh
tesota accounts add claude-code personal
tesota accounts add openai-codex work
```

In the shell, `/login` → **Add an account** does the same. Names contain
letters, digits, `_` or `-`, and are unique within a provider.

- **Claude:** Tesota makes the account's folder,
  `~/.tesota/accounts/claude-code/<name>`, and starts your own Claude Code's
  sign-in there (`claude auth login`, with `CLAUDE_CONFIG_DIR` set to that
  folder). Sign in as Claude Code asks. Tesota records the account once
  Claude Code says it is signed in, and records nothing when it isn't.
- **ChatGPT:** Tesota runs its ChatGPT sign-in for the account's own slot,
  `openai-codex@<name>`, then records the account.

The account is then a provider like any other, in this shell at once and in
every later run, with nothing to edit:

```sh
tesota -p "Review the change" --model claude-code@personal/claude-opus-5-5
```

`tesota accounts` lists each account with the account it is signed in to,
and flags `same account as …` when two identify the same one (the shell's
`/accounts` shows the same, in [the usage panel](#usage-of-your-accounts)):

```text
claude-code (default)  owner@example.com
claude-code@personal  owner@example.com · same account as claude-code  /home/you/.tesota/accounts/claude-code/personal
openai-codex (default)  not signed in
openai-codex@work  <ChatGPT account ID>
```

| To | Command line | Shell |
| --- | --- | --- |
| Sign one in again, keeping it | `tesota accounts login claude-code@personal` | `/accounts`, choose the account, Enter, **Sign in again** |
| Remove one | `tesota accounts remove openai-codex@work` | `/accounts`, choose the account, Enter, **Remove** |

Removing an account that your `model` setting, or the `model` of one of
your agent types or the current project's, still names is refused, naming
which: choose another account there first. Removing a ChatGPT account
forgets its sign-in. Removing a Claude account deletes the folder Tesota
made for it under `~/.tesota/accounts/claude-code`, unless another account
uses it; a folder you declared yourself stays. Tesota adds a Claude account
only in a folder it makes, never in one already there. While the `accounts`
setting is invalid, adding and removing are refused, so it is never written
over.

### Usage of your accounts

`/usage` in the shell opens the **Usage** panel on its Usage tab, and
`/accounts` opens it on its Accounts tab. Tab or ←/→ switch tabs, and Esc
closes the panel; the session keeps running beneath it.

- **Usage:** for each account, a row per limit window (the 5-hour and the
  weekly one, for example): the share left as a meter of segments with its
  percentage, and when it resets (`resets in 3h 12m`). The meter is in the
  warning color at a quarter left or less, and in the error color when
  nothing is left. A meter is empty only when nothing is left and full only
  when nothing is used. On a narrow terminal it has fewer segments, and the
  details wrap beneath it.
- **Accounts:** each account, its provider, and whether it is signed in,
  with the email when the provider gives one. ↑/↓ choose an account and
  Enter offers **Sign in again** or **Remove**, as above; `a` adds an
  account. The tab names the command to run from a terminal. A provider's
  default sign-in is listed too (marked `default`) but is not managed here.
- **This session** marks the account the session draws on, in both tabs.
  The default sign-in the session uses is listed even when no account of its
  provider is declared.

The panel opens at once with every account, marked `checking sign-in…`
until its sign-in is checked, a few at a time. Once an account's sign-in is
known, its reading saved in the past hour shows, faded and with its age,
and is replaced as it is read; `r` stops the reads still going and reads
again, and closing the panel stops them. A saved reading shows only for the
sign-in it was read for: an account signed in again as someone else shows
none. A read that fails, or whose reply is not understood, shows the last
reading of the past hour, `last known, 25m ago: <why>`, or else the reason.
Each read has a 20-second limit and never blocks the panel or the session. Accounts that are one underlying account
are read once, and the others say `same account as …`.

| Provider | Where the reading comes from |
| --- | --- |
| `claude-code` | Claude Code's own experimental usage report, asked of your Claude Code in the account's folder (`CLAUDE_CONFIG_DIR` only). The report may change in Claude Code's releases. |
| `openai-codex` | Codex's usage endpoint, with the account's own sign-in from `~/.tesota/auth.json`, refreshed when it has expired |

ChatGPT through the `openai` sign-in reports no limits that can be read;
the Codex sign-in (`openai-codex`, **OpenAI Codex (legacy)** in `/login`)
does. When OpenAI is signed in with ChatGPT and no Codex sign-in is among
the accounts, the Usage tab says so in one line, marked `this session` when
the session runs on it. An OpenAI API key shows no line.

No other provider reports limits. The readings are saved in
`~/.tesota/usage.json` with their time and a one-way fingerprint of whom
they were read for; no token, credential, email or account ID.

### Declaring accounts by hand

The accounts are the `accounts` list in your `~/.tesota/settings.json`, not
a project's file, which you can also write yourself, for example to use a
Claude Code folder you already have:

```json
{
  "accounts": [
    { "name": "personal", "provider": "claude-code", "folder": "/absolute/path/to/claude-personal" },
    { "name": "work", "provider": "openai-codex" }
  ],
  "model": "claude-code@personal/claude-opus-5-5"
}
```

Use an absolute folder for Claude Code (`C:/accounts/claude-personal` on
Windows, for example). Restart Tesota after editing the list by hand, then
sign the account in with `tesota accounts login <provider>@<name>`.

### How accounts sign in

Tesota sets `CLAUDE_CONFIG_DIR` to a Claude account's folder for that
account's Claude Code only, for its sign-in, status and runs. Named instances ignore ambient `ANTHROPIC_*` and
`CLAUDE_*` overrides so a shell token or API key cannot replace the folder's
sign-in. Tesota never changes `HOME`, and never reads, copies or stores
Claude Code's credentials; the usage panel asks Claude Code the same way. It asks `claude auth status` in that folder for
sign-in status and the account label.

Each ChatGPT account has its own credential slot in `~/.tesota/auth.json`;
logging out of one does not sign another out. The plain provider ID remains
the default account, separate from the named instances.

Choose an account exactly as you choose a model: `/model`, `--model`, the
saved `model`, an agent type's `model`, or the `agent` tool's `model`.
For example, a type can name `openai-codex@work/gpt-6.1-sol`. Run receipts
keep the account-qualified model. The model and login lists label instances
with Claude's email or ChatGPT's account ID and flag `same account as …`
when two instances identify the same account, including the default. Print
mode also reports the account labels. If the provider cannot report an
identity, Tesota says it is unavailable rather than guessing.

**Tesota never switches accounts automatically.** A limit ends that run
with the provider's message; only you can explicitly choose another account.
Use only your own accounts, never a shared account.

## Thinking

For a model that reasons, `/settings` → **Thinking** sets how hard it
thinks: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. The
footer shows it beside the model when it isn't off. A model that doesn't
reason ignores it.

## Models Tesota itself asks

Verification may ask two models for their opinion, labeled as such and
never counted as evidence:

- **The contract comparison** uses the session's model, or the one
  `--claimcheck-model` names.
- **The open cases** your request leaves are listed by GPT-6 Sol, or the
  model `--open-cases-model` names; `off` turns the list off.

[Verification](verification.md#the-models-opinions) covers both.

## Related

- [Configuration](../reference/configuration.md)

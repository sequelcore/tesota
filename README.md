# Tesota

**Tesota makes your coding agent show evidence that its change does what you
asked:** proved where it can, tested where it can't, and it says plainly what
it couldn't verify. It is a verification layer, shipped as a
[Pi](https://pi.dev) package and a `tesota` command that opens Pi with it.

## What it does

When the agent finishes a request, Tesota checks the change before the run
settles.

- **Proves.** It proves the contracts of every changed TypeScript file with
  LemmaScript `//@` contracts, using Dafny. The agent also gets a `prove`
  tool to use while it works.
- **Tests.** It runs the project's own check or test commands, and says
  which changed tests pass without the change, since those tests don't
  exercise it.
- **Measures contract strength.** For each contract the request added or
  changed, it checks whether small changes to the code still prove. If they
  do, the contract is too weak to trust. A model also compares each contract
  with the request; that result is labelled a model's judgment.
- **Sends work back.** A failing proof, a failing test or a weak contract
  goes back to the agent until it is fixed, or until the agent repeats a
  failure it was already shown.
- **Writes a receipt.** The run ends with a receipt of:
  - what was proved and tested;
  - which contracts are weak;
  - what may weaken the evidence, such as a loosened contract or a deleted
    test;
  - what nothing verified, down to the changed lines outside the contracts
    that proved.

  `tesota receipt` writes that receipt for a pull request.

The [verification design](docs/design/verification.md) explains how each
step works.

## What it does not do

- **No sandbox and no permissions.** Tesota verifies results, not actions,
  and is not a security boundary. Pi and you decide which model runs, where
  commands run and what the agent may do.
- **No verifier of its own.** Proofs come from LemmaScript and Dafny. Tests
  come from your project's commands. Tesota runs them and keeps their
  evidence apart from a model's judgment.
- **No proofs without contracts.** Proofs cover TypeScript functions that
  have LemmaScript contracts. Everything else is tested where the project has
  commands, and is otherwise reported as not verified.
- **No acceptance.** A receipt is check evidence. Accepting the change is
  still up to a person.

## Requirements

- **Pi:** version 1.1.0 or later, installed beside Tesota or on `PATH`.
- **Node:** version 22.19.0 or later, which Pi 1.1 requires.
- **Dafny 4:** needed to prove contracts; `mise install` installs the
  version in [mise.toml](mise.toml). Without Dafny, a proof reports that it
  could not run.
- **Git:** needed to tell what changed. Outside a Git repository, Tesota
  only reports that the changes were not verified.
- **Bun and Node:** to build from source, the Bun in `packageManager` and
  the Node in `devEngines` of [package.json](package.json).

**Sharper test evidence (optional).** When your test command writes a JUnit
XML report anywhere under the project, Tesota reads which tests failed
instead of only whether the command did. It can then tell that a new test
exercises your change even when other tests already fail, and send back only
the failures that matter. Gradle and Maven write these reports by default.
Elsewhere:

- Bun: `bun test --reporter=junit --reporter-outfile=./junit.xml`, or
  `[test.reporter] junit = "junit.xml"` in `bunfig.toml`.
- Node's test runner: `node --test --test-reporter=junit --test-reporter-destination=junit.xml`.
- Vitest: its `junit` reporter with an `outputFile`
  ([reporters](https://vitest.dev/guide/reporters)).

## Install and run

Tesota 0.1.0 is an alpha and is not published yet. Install it from a
source checkout:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun link
```

In a checkout, `bun install` also provides Pi.

`tesota` opens Pi with Tesota loaded and passes every argument to Pi:

- `tesota -p "<request>"` runs one request.
- `--claimcheck-model <provider>/<id>` sets a second model for the contract
  comparison to restate contracts with. Without it, the session's model
  restates them.

In the folder where the session ran:

- `tesota receipt` writes the last receipt as Markdown, for a pull
  request's description or a comment.
- `tesota receipt --json` writes the same receipt as an unsigned in-toto
  Statement about the commit `HEAD` names, for CI.

Both name who is accountable, from Git's `user.email` or from
`--owner <login or email>`. They also list the files the commit changed
after the receipt, which nothing in it covers.
[Receipt v1](docs/receipt-v1.md) specifies the format.

Run `bun unlink` in the checkout to remove the command.

### Look and feel

A session opens under Tesota's palo fierro, drawn in the colors of Pi's
active theme and lit against your terminal's background. In Pi's
fullscreen mode, its default, a click on the resting tree plays the scene
again. While the agent works, the scene's tumbleweed rolls where Pi shows
its working indicator; once the agent stops, Pi hides that line, and the
footer shows the gate's own progress.

**The receipt in the conversation.** The receipt's first row says whether
anything needs you, such as `! 4 things need you`. Under it come those
things, then what is not proved, then what holds, in one row. A model's
opinion of the contracts is shown as a note, marked `◇`, and never counts
toward what needs you. Press Ctrl+O to see each one's details, as for any
tool's output; what the gate sent back to the agent, and `prove`'s results,
open the same way.

**Themes.** Tesota brings six Pi themes: `tesota-dark` and `tesota-light`,
and `vesper`, `sequel`, `automata` and `phosphor`. Until you choose a theme,
`tesota` opens Pi in `tesota-light` or `tesota-dark`, following your
terminal's light or dark appearance, without saving anything to Pi's
settings. A theme you choose always wins: open `/settings`, select
**Theme**, and choose one, or a light and a dark one as a pair; `tesota
--use-theme <name>` picks one for a single run. Pi itself, with Tesota
installed through `pi install`, keeps its own theme.

**A quieter start.** Pi lists the context, skills and extensions it loaded
beneath the header, so the tree keeps to a third of the window. To give it
half, hide the list in Pi's settings file, `~/.pi/agent/settings.json`:

```json
{ "quietStartup": "header" }
```

Pi has no flag for this, so `tesota` leaves the setting to you;
`tesota --verbose` shows the list again for one run.

**Terminal colors.** The themes are drawn for a `#202020` canvas (light:
`#edede5`). Tesota's terminal color schemes, in
[`terminal-schemes`](terminal-schemes), set that canvas and an ANSI palette
from the same colors. They are optional:

- Windows Terminal: copy `windows-terminal/tesota.json` to
  `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\Tesota\`, restart
  Windows Terminal, and choose **Tesota Dark** or **Tesota Light** as a
  profile's color scheme. Windows Terminal shows bold text, such as the
  header's `Tesota`, as a brighter color by default; set the profile's
  **Intense text style** (`intenseTextStyle`) to **Bold font** to draw it
  bold.
- Ghostty: copy the files in `ghostty` to `~/.config/ghostty/themes/` and
  set `theme = light:Tesota Light,dark:Tesota Dark`.
- WezTerm: copy the files in `wezterm` to `~/.config/wezterm/colors/` and
  set `config.color_scheme = "Tesota Dark"`.

**Input and footer.** The input is a filled block in the theme's
`userMessageBg`, the color of your sent messages, with a bar down its left
edge in Pi's border color, which follows the thinking level and bash mode.
Beneath it the footer shows, first, what Tesota knows about the current
request:

- before a request, what it can verify here: `● ready · proofs and tests`,
  `● ready · tests only`, or `● ready · nothing to check with`;
- while the gate works, its step and what the round found so far, such as
  `◐ proving… · 1 proved · tests pass`;
- after the run, the receipt in brief, such as
  `✓ receipt · 1 proved · tests pass · 3 lines not proved`.

The context window's use sits at its right. The second row holds the folder
and branch, with the model at its right. On a narrow terminal the model
goes first, then the evidence shortens, and the context % goes last.
Statuses from other extensions follow on a third row.

## Credits

Tesota proves contracts with [LemmaScript](https://github.com/midspiral/LemmaScript)
by Midspiral (MIT) and [Dafny](https://github.com/dafny-lang/dafny). Its
contract comparison adapts the round-trip method of
[ClaimCheck](https://github.com/metareflection/claimcheck) by metareflection
(MIT). See [NOTICE](NOTICE).

## The name

Tesota takes its name from *Olneya tesota*, the desert ironwood, *palo
fierro* in Spanish: a tree of the Sonoran Desert whose wood is dense enough
to sink in water, and under whose shelter other plants take root. The name
stands for a durable foundation that supports growth.

## Documentation

| Need | Read |
| --- | --- |
| Current status and next work | [Roadmap](docs/roadmap.md) |
| How verification works | [Verification design](docs/design/verification.md) |
| The receipt's format | [Receipt v1](docs/receipt-v1.md) |
| Why Tesota is a verification layer | [Decision record](docs/decisions/2026-10-08-verification-layer.md) |
| Build, test and contribution practice | [Development](docs/development.md) |

Tesota is licensed under [Apache-2.0](LICENSE). Preserve [NOTICE](NOTICE) and
retained third-party notices. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).

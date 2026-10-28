# Tesota

**A coding agent that checks its code, challenges its specs, and flags where they may miss your request.**

[![CI](https://github.com/sequelcore/tesota/actions/workflows/ci.yml/badge.svg)](https://github.com/sequelcore/tesota/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/sequelcore/tesota?include_prereleases&sort=semver)](https://github.com/sequelcore/tesota/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/tesota-turn-light.svg">
  <img alt="A run in Tesota whose change misses the request: the request asks for 10 off orders over 100, the agent's change takes 10 off at 100 too, and the receipt shows the proof and tests passing and the new test catching the change, then, apart as a model's opinion, that the contract does not match the request." src="docs/assets/tesota-turn-dark.svg">
</picture>

## Three questions

When the agent finishes, Tesota answers three questions about the change,
and keeps the answers apart in its receipt:

1. **Does the code pass its checks?** Your project's tests run on the
   change, contracts are proved with Dafny, and a new test must fail on the
   starting code to count as catching the change. This is evidence.
2. **Are the checks strong enough to mean something?** Tesota changes the
   code on purpose: a contract that still proves is too weak, and goes back
   to the agent. A deleted test or a loosened contract is flagged. This is
   evidence too.
3. **Do the checks say what you asked?** No tool can prove that. A model
   restates the changed contracts in plain words, compares them with your
   request, and lists inputs your request leaves open. This is a model's
   opinion: labeled as one, and never counted as verified.

A proof can hold for a strict contract that describes the wrong boundary.
Tesota makes that gap visible; it doesn't close it.

## What you get

- You see what was actually checked, instead of taking the agent's word that it's done.
- A deleted test, an added `.skip` or a loosened contract is flagged in the
  receipt before the change reaches your pull request.
- The receipt says plainly what Tesota couldn't check, such as changed lines
  no check covered or a checker that wasn't installed.
- `tesota receipt` prints the receipt as Markdown for a pull request, and
  `tesota receipt --json` prints it for CI.
- **Use the model you already pay for.** Any [pi-ai](https://github.com/earendil-works/pi)
  provider works, such as OpenAI, Anthropic, Google, OpenRouter, Mistral,
  xAI, Amazon Bedrock or Azure. A Claude plan runs through your own Claude
  Code, and a ChatGPT plan through its sign-in. See [Models](docs/guides/models.md).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1 | iex
```

If the Linux or macOS script added Tesota to your `PATH`, open a new
terminal first, or run the line it prints. Then, in your project:

```sh
tesota
```

Type `/login` to sign in to a model provider, then ask for a change. Tesota
is in alpha, released as prerelease binaries. You need Git, and
[Dafny 4](https://dafny.org) to prove contracts.
[Install](docs/get-started/install.md) and
[your first session](docs/get-started/first-session.md) go step by step.

## The receipt

When the agent finishes, Tesota verifies the change and writes a receipt.
The run in the image above ends with this one:

```text
Tesota receipt
No review flags · no verification limits
Check evidence, not your acceptance.

✓ Tested      npm run test · 0:00
✓ Proved      src/total.ts · 0:02
○ Models      none recorded
✓ Exercised   1 test file failed on the base and passed with the change
✓ Contracts   1 contract: every decided change broke its proof

Model opinions · not evidence, not counted
◇ ClaimCheck: does not match the request · total · src/total.ts
```

Every check passed, and the change is still wrong. The request said
*over* 100, but the agent's code, its contract and the test it wrote all
take 10 off at exactly 100. The checks agree with each other, so only the
request review notices: a model restated the contract and found it doesn't
match. That opinion doesn't count as verified and doesn't block the run;
it shows you where to look. In this run the agent and the model's opinions
are scripted; the tests and the proof ran for real.

A receipt records:

- what was proved, tested and model-checked;
- any weakened evidence it found, such as a loosened contract, a deleted
  test or an added `.skip`;
- what it couldn't verify: changed lines and files that no check covered.

A run ends verified only when that evidence holds. The receipt is
evidence; accepting the change is up to you. See [Receipts](docs/guides/receipts.md) and the
[receipt format](docs/receipt-v2.md).

## The checks

On a project with no contracts or design models, a run still runs your
project's tests on the change, checks whether a new or changed test
catches it, flags weakened tests and names the changed files no proof
covers. Tests run only through the commands Tesota finds, such as a
`package.json` `check` or `test` script, `cargo test` or `go test`; a
project with none gets no tests. Whether a test catches the change is
checked only when the current checks pass and Tesota has a trustworthy
starting commit, and stays unknown when the change touches dependency
files. Contracts and design models, when you add them, add the checks
below.

- **Proofs:** TypeScript functions with LemmaScript contracts, proved with
  Dafny. A contract that still proves after the code is changed is too weak,
  and goes back to the agent, unless Dafny proves the changed code returns
  the same result for every input the contract admits. A proof is only as
  good as its contract, so Tesota checks both. It cannot check that the
  contract says what you asked; a model's comparison with your request is
  only a review aid.
- **Tests:** your project's own commands, run against the change, with a
  check that a new test catches it.
- **Design models:** TLA+ and Quint models of the design, checked with TLC
  when the change touches the code they cover. Each planted fault must
  break one.

A failing check goes back to the agent. [Verification](docs/guides/verification.md)
and [model checking](docs/guides/model-checking.md) show how to give
Tesota more to check; [how verification works](docs/concepts/verification.md)
explains the rest.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/tesota-welcome-light.svg">
  <img alt="Tesota's shell as it opens: the ironwood mark beside the name, model, folder and tagline; a faded ironwood and its saguaro seedling centered above the input band and footer." src="docs/assets/tesota-welcome-dark.svg">
</picture>

## Documentation

| | |
| --- | --- |
| [Get started](docs/get-started/install.md) | Install Tesota and run your first request |
| [Guides](docs/README.md#guides) | Sessions, verification, receipts, permissions, models, hooks, MCP and more |
| [Concepts](docs/README.md#concepts) | How Tesota is built and how it verifies |
| [Reference](docs/README.md#reference) | Commands, configuration, proved rules, the glossary and the receipt format |
| [Roadmap](ROADMAP.md) | Principles, non-goals and focus areas |
| [Changelog](CHANGELOG.md) | What each release changed |
| [Contributing](CONTRIBUTING.md) | Report an issue or propose a change |
| [Security](SECURITY.md) | The threat model, and how to report a vulnerability |

## Credits

Tesota proves contracts with [LemmaScript](https://github.com/midspiral/LemmaScript)
by Midspiral and [Dafny](https://github.com/dafny-lang/dafny). It checks
design models with [TLC](https://github.com/tlaplus/tlaplus), and Quint
models through your own [Quint](https://github.com/informalsystems/quint)
install. Its contract comparison adapts the round-trip method of
[ClaimCheck](https://github.com/metareflection/claimcheck) by
metareflection. It reaches models through
[pi-ai](https://github.com/earendil-works/pi), draws the terminal with
pi-tui and connects to MCP servers with pi-mcp. It searches with
[ripgrep](https://github.com/BurntSushi/ripgrep), reads code with
[tree-sitter](https://github.com/tree-sitter/tree-sitter), and draws model
graphs with [Cytoscape.js](https://js.cytoscape.org/). [NOTICE](NOTICE)
lists every credit and license.

Tesota is named for *Olneya tesota*, the desert ironwood, *palo fierro* in
Spanish: a tree of the Sonoran Desert whose wood sinks in water, and under
whose shelter other plants take root.

Licensed under [Apache-2.0](LICENSE).

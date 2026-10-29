<h1>
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/tesota-wordmark-light.svg">
    <img alt="Tesota" src="docs/assets/tesota-wordmark-dark.svg" width="232">
  </picture>
</h1>

**A coding agent that checks its code, challenges its specs, and flags where they may miss your request.**

[![CI](https://github.com/sequelcore/tesota/actions/workflows/ci.yml/badge.svg)](https://github.com/sequelcore/tesota/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/sequelcore/tesota?include_prereleases&sort=semver)](https://github.com/sequelcore/tesota/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/tesota-turn-light.svg">
  <img alt="A run in Tesota whose change misses the request: the request asks for 10 off orders over 100, the agent's change takes 10 off at 100 too, and the receipt shows the proof and tests passing and the new test catching the change, then, apart as a model's opinion, that the contract covers only part of the request because it takes 10 off at 100 too." src="docs/assets/tesota-turn-dark.svg">
</picture>

Every run ends with a receipt: what was proved, what was tested, and what
nothing checked. You see the evidence instead of taking the agent's word.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1 | iex
```

Then, in your project, run `tesota` and type `/login`. You need Git, and
[Dafny 4](https://dafny.org) to prove contracts. Tesota is in alpha;
[Install](docs/get-started/install.md) has the details.

## The receipt

```text
Tesota receipt
No review flags · no verification limits · 1 opinion to read
Evidence, not approval: accepting the change is yours.

✓ Tested      npm run test · 0:00
✓ Proved      src/total.ts · 0:02
○ Models      none recorded
✓ Exercised   1 test file failed on the base and passed with the change
✓ Contracts   1 contract: every decided change broke its proof

Model opinions · not evidence, not counted
◇ ClaimCheck: covers only part of the request · total · src/total.ts
  The contract captures the subtraction and unchanged cases, but applies the
  10-unit reduction at amount = 100 as well. The request says orders over
  100, so this boundary should remain unchanged.
```

Every check passed, and the change is still wrong: the request said *over*
100. Only the request review notices, and it is a model's opinion, kept
apart and never counted as verified. In this run the agent is scripted;
the tests, the proof and the model's words are real.

`tesota receipt` prints the receipt as Markdown for a pull request, and
`--json` for CI. See [Receipts](docs/guides/receipts.md).

## What it checks

- **Tests:** your project's own commands, on the change, and whether a new
  test fails without it.
- **Proofs:** TypeScript contracts proved with Dafny. A contract that still
  proves after Tesota changes the code is too weak.
- **Design models:** TLA+ and Quint, checked with TLC when the change
  touches the code they cover.

A failing check goes back to the agent. A deleted test, an added `.skip` or
a loosened contract is flagged. [How verification works](docs/concepts/verification.md)
explains the rest.

Use the model you already pay for: any [pi-ai](https://github.com/earendil-works/pi)
provider, a Claude plan through your own Claude Code, or a ChatGPT plan.
See [Models](docs/guides/models.md).

## Documentation

[Get started](docs/get-started/install.md) · [Guides](docs/README.md#guides) ·
[Concepts](docs/README.md#concepts) · [Reference](docs/README.md#reference) ·
[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Credits

Tesota proves contracts with [LemmaScript](https://github.com/midspiral/LemmaScript)
and [Dafny](https://github.com/dafny-lang/dafny), checks design models with
[TLC](https://github.com/tlaplus/tlaplus) and [Quint](https://github.com/informalsystems/quint),
and adapts [ClaimCheck](https://github.com/metareflection/claimcheck)'s
round-trip method. It runs on [pi-ai](https://github.com/earendil-works/pi),
pi-tui and pi-mcp. [NOTICE](NOTICE) lists every credit and license.

Named for *Olneya tesota*, the desert ironwood of the Sonoran Desert, whose
wood sinks in water and under whose shelter other plants take root.
Licensed under [Apache-2.0](LICENSE).

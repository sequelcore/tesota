# Install

Tesota is in alpha and not published yet, so you install it from its
source. The `tesota` command then runs that source with Bun.

## Requirements

| | Needed for |
| --- | --- |
| [Bun](https://bun.sh), the version in `packageManager` of [package.json](../../package.json) | Running Tesota |
| [Git](https://git-scm.com) | Measuring each change from where the request started. On Windows, Git's bash also runs your project's check commands |
| [Dafny 4](https://dafny.org), as `dafny` on your `PATH` | Proving LemmaScript contracts. Without it, a proof says Dafny isn't installed and proves nothing |

[mise](https://mise.jdx.dev) installs the Dafny version Tesota is tested
with: run `mise install` in the checkout.

## Install from source

```sh
git clone https://github.com/sequelcore/tesota
cd tesota
bun install --frozen-lockfile --ignore-scripts
cd packages/core
bun link
```

`bun link` puts `tesota` on your `PATH`, in Bun's `bin` folder. Check it:

```sh
tesota --version
```

To update, pull the checkout and run `bun install` again; the linked
command runs the new source.

## Sign in to a model

Open Tesota in any folder and type `/login`:

```sh
tesota
```

`/login` lists the providers Tesota reaches through
[pi-ai](https://github.com/earendil-works/pi): some sign in with your
account, others take an API key. An API key in the environment, such as
`OPENAI_API_KEY`, works without `/login`. Then `/model` picks the model.
[Models](../guides/models.md) covers both.

## Uninstall

```sh
cd tesota/packages/core
bun unlink
```

Tesota keeps its state in `~/.tesota`: your settings, sign-ins, sessions,
and the worktrees and snapshots it makes. Delete that folder to remove it
all. [Configuration](../reference/configuration.md) lists what's in it.

## Next

[Your first session](first-session.md).

# Security policy

Tesota is pre-release software, with no supported stable release. Its
[permissions](docs/guides/permissions.md) and their floor limit what the
agent may do, but they're a net of rules and patterns, not a sandbox:
don't treat Tesota as a security boundary.

## Reporting a vulnerability

Don't open a public issue with exploit details, credentials, private
repository content or model transcripts.

Use GitHub's private vulnerability reporting when it's enabled for this
repository. Otherwise, contact the maintainers privately through their
GitHub profiles, with only enough to set up a secure channel.

Include:

- the commit and platform;
- the boundary crossed and what you expected;
- a minimal reproduction without real credentials or private data;
- what happened, and whether it persists;
- any workaround you know.

The most serious reports are: evidence attached to the wrong content; a
change reported as proved or tested when it wasn't; weakened evidence that
goes unreported; a tool call that crosses the permission floor; and a
credential or prompt disclosed.

## Disclosure and scope

Maintainers acknowledge and reproduce a report, find the boundary it
crosses, and coordinate the fix and its disclosure. While Tesota is
pre-release there's no response-time or bug-bounty commitment.

A model's mistake, a weak suggestion or an unsupported kind of task is a
limitation of the product, not a vulnerability, unless it crosses a
confidentiality, permission or evidence boundary.

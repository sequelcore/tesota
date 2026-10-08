# Security policy

Tesota is pre-release software. It has no supported stable release and should
not be treated as a security boundary: it verifies an agent's results and
leaves what the agent may do to the harness that runs it. Current status and
limits are documented in the [roadmap](docs/roadmap.md).

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, private
repository content or retained model transcripts.

Use GitHub private vulnerability reporting when it is enabled for this
repository. If that channel is unavailable, contact the repository maintainers
privately through their GitHub profiles and include only enough public-safe
information to establish a secure reporting channel.

Please include:

- the affected commit and platform;
- the violated boundary and expected behavior;
- a minimal reproduction without real credentials or private data;
- observed effects and whether they persist;
- any known workaround.

High-priority reports include evidence attached to the wrong content, a change
reported as proved or tested when it was not, weakened evidence that goes
unreported, and credential or prompt disclosure.

## Disclosure and scope

Maintainers will first acknowledge and reproduce the report, then determine the
affected boundary and coordinate remediation and disclosure. No response-time or
bug-bounty commitment is made while the project is pre-release.

Model mistakes, low-quality suggestions and unsupported task classes are product
limitations rather than vulnerabilities unless they cross a confidentiality or
evidence-integrity boundary.

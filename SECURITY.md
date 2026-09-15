# Security policy

Tesota is pre-release software. It has no supported stable release and should
not be treated as a security boundary for untrusted workloads. Current platform,
isolation and live-integration limits are documented in the
[roadmap](docs/roadmap.md) and [architecture](docs/architecture.md).

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
- observed effects and whether they may persist outside a candidate checkout;
- any known workaround.

High-priority reports include authority bypass, writes outside the admitted
candidate, credential or prompt disclosure, unconfirmed processes represented as
settled, evidence attached to the wrong candidate, acceptance replay and
promotion of bytes other than those reviewed.

## Disclosure and scope

Maintainers will first acknowledge and reproduce the report, then determine the
affected boundary and coordinate remediation and disclosure. No response-time or
bug-bounty commitment is made while the project is pre-release.

Model mistakes, low-quality suggestions and unsupported task classes are product
limitations rather than vulnerabilities unless they cross an enforced authority,
confidentiality, integrity or promotion boundary.

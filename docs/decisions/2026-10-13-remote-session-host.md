# Happier as the recommended remote host

Date: 2026-10-13
Status: Accepted recommendation; Pi integration remains experimental.
Issue: [#388](https://github.com/sequelcore/tesota/issues/388)

## Decision

Recommend Happier for operating Tesota's Pi sessions from a phone. The owner
has used Happier on Android and accepts its interface and session workflow.
Happier is optional: Tesota neither installs it nor requires its relay.
The [remote-work guide](../remote-work.md) owns setup and use.

Pi owns models, tools, execution and sessions. Tesota owns verification and
the receipt. Happier owns remote interaction, transport and host lifecycle.
Connectivity, credentials and access policy remain host configuration.
Tesota continues to compose Pi's public extension points; it adds no remote
server, mobile application or replacement session engine.

## Why Happier

Pi Web demonstrated remote verification and receipt persistence on Windows,
but the owner rejected its mobile interface. Happier fits the owner's actual
workflow and runs Pi through its CLI RPC interface, preserving Tesota's
extension and explicit options when launched through `tesota`. A separate
Tesota interface or a Pi Web fork would duplicate host responsibilities.
Remote terminal access remains an alternative, not a dependency.

Happier is independent of the model provider selected through Pi. This does
not make Tesota independent of the harness: Happier's Direct Codex sessions
do not run Tesota's Pi extension.

## Evidence and release boundary

The Windows and Android pilot used Pi 1.2.0 and a local Happier 0.2.16 source
checkout at `5041ba7a500bc77d8760095d9fe094ed853724cf`. The adapter required
corrections to wait for `agent_settled`, forward displayed extension entries
and avoid treating a transcript message as completion for CLI waiting.
These corrections are local, not a released upstream integration.

- Real Pi and Dafny runs exercised proof failure, send-back and correction.
  Live ClaimCheck preserved the explicitly selected second model.
- A healthy live relay turn delivered the complete receipt before completion
  and before CLI waiting returned. The owner confirmed reading it on Android.
  Eighty-four focused host tests and type checking passed; seven broader RPC
  failures also reproduced without the corrections.
- The owner accepted Happier through ongoing use and confirmed Windows
  startup without a visible console after reboot. Runner-loss recovery and
  repeated resume passed for the selected Pi conversation. The later Pi
  automatic-reopen policy has not had a full reboot qualification.
- Private HTTPS and WebSocket access checks passed for the configured owner;
  a different real tailnet user's access has not been tested.

Acceptance of the host is the owner's decision. These checks support the
observed behavior; they do not establish every remote workflow or guarantee
unmodified Happier releases behave the same way.

## Remaining limits

Happier [labels Pi experimental](https://docs.happier.dev/agents/pi).
Publication of the local corrections and Android completion timing,
interruption, steering and concurrent-session qualification remain open.
The Markdown receipt's generation and exact delivery through the local RPC
adapter are checked; its new layout still requires viewing on the phone.
This adoption does not expand that test scope.

A recovered conversation and an existing receipt are not recovered execution.
The isolated interruption trial recovered the conversation but did not restart
the interrupted turn or gate. Pi Durable's
[coding-agent extension support](https://github.com/earendil-works/pi/issues/10386)
remains a separate upstream requirement. The computer must stay powered and
awake for work to continue.

# Remote work with Happier

Happier is Tesota's recommended remote host. Run Pi and Tesota on the
computer that holds your project, then use Happier from your phone to send
requests and read the verification receipt. You choose the model through Pi.
Happier is optional and is not installed by Tesota.

**Current status:** Happier labels its Pi integration experimental. The
Windows and Android pilot uses local adapter corrections for settlement,
receipt delivery and CLI waiting. Those corrections are not a published
Happier release. The recommendation reflects the owner's use and acceptance;
it does not mean an unmodified release has passed the same checks. See the
[decision](decisions/2026-10-13-remote-session-host.md).

## Set up the computer and phone

1. Install Pi and build Tesota using the [README](../README.md#requirements)
   and [development instructions](development.md#toolchain-and-checks).
   Confirm `tesota` opens Pi with the `prove` tool available.
2. Follow Happier's [onboarding](https://docs.happier.dev/getting-started/onboarding)
   to install its app and CLI, choose a relay, link the computer and configure
   its background service. Select the same relay and account on the phone.
3. Create the Node launcher below outside your project and configure the
   background service's `HAPPIER_PI_PATH` to its absolute `.mjs` path.
   Restart the service after changing its environment. This loads Tesota
   through its launcher and preserves Happier's RPC arguments.
4. Authenticate Pi on the host, using the same writable agent profile as
   the background service. Keep one authentication store; copying OAuth
   credentials between profiles can leave refreshed credentials out of sync.
5. In the project directory, start a session with `happier pi`, or select Pi
   and that project on the linked machine in the app.

Save this as `pi-tesota.mjs`, replacing the path with your built Tesota
entry point. On Windows, use a path such as `C:/path/to/tesota/dist/cli.js`.

```js
#!/usr/bin/env node
import { pathToFileURL } from "node:url";
await import(pathToFileURL("/absolute/path/to/tesota/dist/cli.js").href);
```

For an explicit option such as `--claimcheck-model`, add it to `process.argv`
with `process.argv.splice(2, 0, "--claimcheck-model", "<provider>/<id>")`
before the import. Preserve every argument Happier supplies. Model selection
and credentials belong in host configuration, outside repository instructions.

Happier's [Pi guide](https://docs.happier.dev/agents/pi) owns installation,
provider detection and supported host settings. Its online documentation
can describe development features; check the installed release before
depending on them.

## Use the session

Send your request in the Pi session. Tesota verifies changes before the run
settles and returns failures to the agent. An assistant saying it is finished
is not the receipt: look for **Tesota receipt**, with the evidence and its
limits. ClaimCheck remains labelled a model's judgment.

The chat receipt uses headings and lists that wrap on a phone. Pi keeps the
structured receipt in the session. From the project on the host,
`tesota receipt` writes it for a pull request; [receipt v1](receipt-v1.md)
explains what it records. You still decide whether to accept the change.

Closing the phone app leaves the work on the host. Reopen the same session
to continue. The computer must remain powered and awake. A persisted
conversation or receipt does not restore a model turn or verification that
was interrupted by a process exit or reboot.

Happier's Direct Codex sessions are a separate route. Using them does not
load Tesota's Pi extension.

## Private access

For a private relay, use Happier's self-hosted setup and an address both
devices can reach. With Tailscale, connect the computer and phone to your
tailnet and publish HTTPS through Serve. Funnel is unnecessary for private
access. Access policy determines which other devices can connect; model
requests still go to the provider you configured.

Keep relay access, authentication and automatic startup in host
configuration. Tesota verifies results and does not enforce execution
permissions or network access.

## If something is missing

- **Pi is not detected:** check `pi --version`, the `HAPPIER_PI_PATH` value
  and the service's environment, then restart the service.
- **No receipt appears:** confirm this is a Pi session with Tesota loaded.
  The adapter must forward displayed `custom_message` entries, including
  `tesota-receipt`; an assistant's final message is insufficient.
- **The client finishes while verification is running:** its adapter must
  wait for Pi's `agent_settled`, not `agent_end`. The same distinction must
  apply to CLI `--wait`.
- **A reboot leaves the conversation offline:** restart or resume its host
  runtime through Happier. Conversation recovery is not execution recovery.

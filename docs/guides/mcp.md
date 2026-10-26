# MCP servers

Tesota connects to [Model Context Protocol](https://modelcontextprotocol.io)
servers, local or remote, and gives the agent their tools and resources.

## Configure

`mcp.json`, in the `mcpServers` format Claude Code and Gemini CLI use:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    },
    "sentry": { "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

| File | |
| --- | --- |
| `~/.tesota/mcp.json` | Yours, for every project |
| `<repository root>/.tesota/mcp.json` | The project's, which start only once you trust them |

| Field | |
| --- | --- |
| `command`, `args`, `env`, `cwd` | A local server: the program to run, as a program and its arguments, not a shell line. `cwd` defaults to the session's folder |
| `url`, `headers` | A remote server, over streamable HTTP |
| `oauth` | A remote server's sign-in, when it needs a registered client: `clientId`, `clientSecret`, `callbackPort` or `callbackUrl`, `scope`, `clientName` |
| `timeout` | Seconds a request may take; 60 by default, renewed while the server reports progress |
| `enabled` | `false` keeps the entry without starting it |

- `${NAME}` in `env`, `headers` and `oauth.clientSecret` reads the
  environment variable `NAME`; a leading `~/` names your home folder.
- A project entry replaces yours of the same name. One with only
  `enabled` turns yours on or off in that project; turning one on asks for
  the project's trust.
- An entry Tesota can't read is reported and left out; the rest start.
- The SSE transport isn't supported; servers that offer it usually serve
  streamable HTTP at `/mcp`.

## Tools and resources

A server's tools reach the agent as `mcp__<server>__<tool>`, alongside
Tesota's own. Each one is a call that [runs something](permissions.md):
asked about in ask mode, refused in read only, whatever the server says of
it. [Hooks](hooks.md) see them by the same name.

When a server offers resources, the agent also gets
`list_mcp_resources`, `list_mcp_resource_templates` and
`read_mcp_resource`, which only read.

Servers connect in the background as a session starts; the first request
waits up to 10 seconds for them. Each workspace runs its own servers, so a
session in a worktree never reaches servers working in another. A server
that drops reconnects on its next call.

## Sign in to a remote server

A remote server that uses OAuth, such as Sentry, needs nothing in
`mcp.json` but its `url`. Then:

```text
/mcp login sentry
```

Tesota shows the page to open, and waits for the browser to come back.
Tokens are kept in `~/.tesota/mcp-auth.json`, by server name and address,
readable only by you and refreshed as they expire. A server given its own
`Authorization` header never signs in.

## `/mcp`

| | |
| --- | --- |
| `/mcp` | Lists each server with its state, its tools and its last error, to reconnect, sign in or sign out |
| `/mcp reconnect <server>` | Connects it again |
| `/mcp login <server>` | Signs in |
| `/mcp logout <server>` | Forgets its sign-in |

## Related

- [Permissions](permissions.md)
- [Configuration](../reference/configuration.md)

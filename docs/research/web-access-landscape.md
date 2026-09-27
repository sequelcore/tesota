# Web access landscape (September 2026)

How coding agents give models web search and page fetching, how they contain
the risk, and what Kiln's Capability Fabric and web tools offer Tesota.
Researched on 2026-09-26 from the harnesses' official documentation, Kiln at
the protected tag `kiln-legacy-2026-09`, and the sources linked below. It
informs the web access decision; recheck product behavior before relying on
it.

## The risk

A web tool gives Tesota's agent the third element of the "lethal trifecta":
it already has private data (the repository, which for a first user holds real
records) and may run commands; web pages add untrusted content, and every
fetched URL is itself a channel out, since a query string can carry data. The
reliable defense is to break one element rather than to rely on the model
refusing ([Willison, 2025](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)).
OpenAI's guidance is the same: keep untrusted text out of instructions, and
limit what an agent can reach ([OpenAI](https://developers.openai.com/api/docs/guides/agent-builder-safety)).

## How harnesses do it

| Harness | Search | Fetch | Containment |
| --- | --- | --- | --- |
| Claude Code ([tools](https://code.claude.com/docs/en/tools-reference)) | Anthropic's backend; titles and URLs only; allowed or blocked domains; at most 200 searches a session | Page to Markdown, then a small fast model answers a prompt about it, so the main model reads the answer, not the page | Refuses localhost and dot-less hosts; upgrades to HTTPS; truncates; does not follow a redirect to another host; asks per domain, with rules saved per repository; checks each hostname against Anthropic's blocklist |
| Codex ([web search](https://learn.chatgpt.com/docs/web-search)) | OpenAI's hosted tool: `cached` by default, from an OpenAI-maintained index, which "reduces exposure to prompt injection from arbitrary live content"; `live` fetches current pages; `disabled` | Through search and shell | Results still treated as untrusted |
| Pi | None built in; community extensions such as `pi-webfetch` and `pi-web-access` | Extensions | Per extension. Pi's transports cannot pass a provider's hosted search tool |
| opencode ([tools](https://opencode.ai/docs/tools/)) | `websearch`, through Exa with fallback providers | `webfetch` | Permissions per URL and per query: allow, ask or deny |
| Hermes Agent ([web search](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search)) | Pluggable: Firecrawl by default, SearXNG, Brave, Tavily, Exa, Parallel and others | `web_extract`, separate provider | Provider chosen by configured keys |

Search providers without a lab behind them, as reported in September 2026:
Brave replaced its free tier with a $5 monthly credit, about 1,000 queries;
Tavily gives 1,000 credits a month; Exa's free allowance is reported both as
$10 of monthly credit and as 20,000 requests, so it needs checking at sign-up;
SearXNG is free and self-hosted, a metasearch engine run on the operator's
machine with no key or query log.

## Kiln

**Web tools.** Kiln built `web_search`, `web_fetch` and `web_extract` as
read-only tools behind provider adapters (`http`, `searxng`, `brave`,
`tavily`, `exa` for search; `http`, `tavily`, `firecrawl` for extraction),
with invariants worth keeping: everything fails closed when unconfigured;
**provider availability is global, network authority is per project**, so an
adapter can exist without being allowed in a repository; `web_fetch` rejects
private and localhost targets, validates every redirect hop, caps bytes,
accepts only text types and sanitizes what reaches the model; errors are
typed (`domain_denied`, `provider_not_configured`, `empty_extraction`, …); an
empty extraction is an error, never an empty success; credentials are named by
environment variable, never stored. Research over many pages was a separate,
later capability, not a tool.

**Capability Fabric** (roadmap 11) is a catalog of stable capabilities, such
as `web.search`, resolved per call to one admitted implementation: a
portable tool, a hosted tool, another harness's native tool, or a governed
agent that owns the tool and returns a typed result. The caller never
receives another harness's tool, credentials or permissions. It carried
versioned descriptors, digests, discovery adapters for three harnesses and
eight planned slices, and was still in progress when Kiln stopped.

What carries over to Tesota is the separation, not the catalog. One tool
identity with implementations chosen behind it fits Tesota's engine contract
(decision 022), which requires the same tools on every engine even though
only Claude Code reaches a hosted search. Kiln's agent-backed capability is
what Tesota's explorers already are: a governed read-only session that
answers a question and returns only its answer. A catalog, descriptors and
cross-harness discovery have no consumer in Tesota.

## Implications for Tesota

1. **Fetching goes through the same per-destination authority as the
   sandbox's network**: the operator allows a host for the session or the
   repository, or denies it; nothing is reachable by default, and a redirect
   to another host is a new destination.
2. **Search needs one provider seam** so the tool is identical on both
   engines; SearXNG on the operator's machine costs nothing and sends queries
   to no single company, and a keyed provider can sit behind the same seam.
3. **Untrusted pages should reach a session that cannot act.** Claude Code
   gives the page to a small model; Tesota can give it to an explorer, which
   has no shell and no writes and returns an answer the agent treats as a
   lead. Raw page text in the agent's own context is the riskier design.
4. **Kiln's fetch invariants apply as they are**: no private or local
   targets, per-hop redirect checks, byte and type limits, typed errors, and
   fail-closed defaults.

/**
 * Pi's optional Google provider peer is not needed by the synthetic faux path.
 * Keep the absent peer type-only and avoid adding a provider-specific runtime
 * dependency to this experiment. pi-ai 0.85.1 pins @google/genai 1.52.0,
 * whose declarations import Client from its optional SDK peer (^1.25.2).
 * The required never member makes this placeholder uninhabitable.
 * When Tesota consumes MCP, remove this placeholder and adopt the genuine
 * supported dependency/contract.
 */
declare module "@modelcontextprotocol/sdk/client/index.js" {
  export interface Client {
    readonly __tesotaOptionalPeerShim: never;
  }
}

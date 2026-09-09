/**
 * Pi's optional Google provider peer is not needed by the synthetic faux path.
 * Keep the absent peer type-only and avoid adding a provider-specific runtime
 * dependency to this experiment.
 */
declare module "@modelcontextprotocol/sdk/client/index.js" {
  export interface Client {
    readonly __tesotaOptionalPeerShim?: never;
  }
}

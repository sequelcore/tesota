import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type Assert<T extends true> = T;
// Type-only regression: a permissive optional member or {} must fail typecheck.
export type OptionalMcpClientRejectsEmpty = Assert<{} extends Client ? false : true>;
export type OptionalMcpClientIsUninhabitable = Assert<Client["__tesotaOptionalPeerShim"] extends never ? true : false>;

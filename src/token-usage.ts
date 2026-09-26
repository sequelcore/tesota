/**
 * The tokens model calls used, by kind, as both engines report them: fresh
 * input, output, input read from the provider's prompt cache, and input
 * written to it. The kinds are priced differently, and a cache read costs a
 * fraction of fresh input, so a total alone overstates what a session that
 * rereads a cached prompt costs.
 */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addTokens(first: TokenUsage, second: TokenUsage): TokenUsage {
  return { input: first.input + second.input, output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead, cacheWrite: first.cacheWrite + second.cacheWrite };
}

/** Every token of every kind: the count review measurements and forecasts compare. */
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

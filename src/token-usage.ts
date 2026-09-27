/**
 * The tokens model calls used, as both engines report them, in the shape of
 * OpenTelemetry's GenAI semantic conventions (`gen_ai.usage.*`): `input`
 * counts every input token, cached or not, and `cacheRead` and
 * `cacheCreation` are the parts of it read from or written to the provider's
 * prompt cache. The kinds are priced differently, and a cache read costs a
 * fraction of fresh input, so a total alone overstates what a session that
 * rereads a cached prompt costs.
 */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

export const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

export function addTokens(first: TokenUsage, second: TokenUsage): TokenUsage {
  return { input: first.input + second.input, output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead, cacheCreation: first.cacheCreation + second.cacheCreation };
}

/** Every token, input and output: the count review measurements and forecasts compare. */
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output;
}

/** A token count as the operator reads it: `640 tokens`, or `48k tokens` past a thousand. */
export function formatTokens(tokens: number): string {
  return tokens < 1_000 ? `${tokens} tokens` : `${Math.round(tokens / 1_000)}k tokens`;
}

/** What a helper session took, as the agent is told it: `12 s, 8k tokens`. */
export function runCost(durationMs: number, tokens: number): string {
  return `${Math.max(1, Math.round(durationMs / 1_000))} s, ${formatTokens(tokens)}`;
}

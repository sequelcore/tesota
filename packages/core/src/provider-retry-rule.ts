/**
 * #698: terminal exclusions win; retry only rate limits, 5xx or other clearly
 * transient failures. Three retries maximum, strictly inside two minutes from
 * the first failure, including the full provider-requested wait.
 * `terminal` and `transient` are normalized provider type/transport evidence.
 */
//@ requires retries >= 0 && elapsedMs >= 0 && delayMs >= 0
//@ ensures terminal ==> !\result
//@ ensures status >= 400 && status < 500 && status !== 429 ==> !\result
//@ ensures !(transient || status === 429 || (status >= 500 && status < 600)) ==> !\result
//@ ensures retries >= 3 || elapsedMs + delayMs >= 120000 ==> !\result
//@ ensures !terminal && !(status >= 400 && status < 500 && status !== 429) && (transient || status === 429 || (status >= 500 && status < 600)) && retries < 3 && elapsedMs + delayMs < 120000 ==> \result
//@ ensures \result ==> !terminal && !(status >= 400 && status < 500 && status !== 429) && (transient || status === 429 || (status >= 500 && status < 600)) && retries < 3 && elapsedMs + delayMs < 120000
export function retryProviderCall(terminal: boolean, transient: boolean, status: number, retries: number,
  elapsedMs: number, delayMs: number): boolean {
  return !terminal && !(status >= 400 && status < 500 && status !== 429)
    && (transient || status === 429 || (status >= 500 && status < 600))
    && retries < 3 && elapsedMs + delayMs < 120000;
}

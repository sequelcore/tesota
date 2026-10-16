/**
 * Whether a measurement keeps to its budget: at most the limit. Startup
 * time and binary size are checked this way on every pull request (#433).
 */
//@ requires measured >= 0 && limit >= 0
//@ ensures \result <==> measured <= limit
export function withinBudget(measured: number, limit: number): boolean {
  return measured <= limit;
}

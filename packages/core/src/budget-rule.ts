/**
 * Whether a measurement keeps to its budget: at most the limit. Startup
 * time and binary size are checked this way on every pull request (#433).
 */
//@ requires measured >= 0 && limit >= 0
//@ ensures \result <==> measured <= limit
export function withinBudget(measured: number, limit: number): boolean {
  return measured <= limit;
}

/** A measurement keeps to its budget when at least one of two attempts is within the limit (#462). */
//@ requires first >= 0 && second >= 0 && limit >= 0
//@ ensures \result <==> (first <= limit || second <= limit)
export function withinBudgetAfterRetry(first: number, second: number, limit: number): boolean {
  return withinBudget(first, limit) || withinBudget(second, limit);
}

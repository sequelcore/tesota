export interface Range {
  start: number;
  end: number;
}

/**
 * The inclusive ranges of consecutive numbers in `numbers`. The caller gives
 * numbers sorted ascending with no repeats; the result groups adjacent values
 * into maximal consecutive runs, preserving order.
 */
//@ requires forall(i: nat, i + 1 < numbers.length ==> numbers[i] < numbers[i + 1])
//@ ensures forall(r: nat, r < \result.length ==> \result[r].start <= \result[r].end)
//@ ensures forall(r: nat, r + 1 < \result.length ==> \result[r].end + 1 < \result[r + 1].start)
//@ ensures forall(x: int, (exists(r: nat, r < \result.length && \result[r].start <= x && x <= \result[r].end)) <==> numbers.includes(x))
export function ranges(numbers: readonly number[]): Range[] {
  const found: Range[] = [];
  if (numbers.length === 0) return found;
  let start = numbers[0] as number;
  let end = numbers[0] as number;
  let _run = 0;
  let k = 1;
  while (k < numbers.length) {
    //@ invariant 1 <= k && k <= numbers.length
    //@ invariant 0 <= _run && _run < k
    //@ invariant start === numbers[_run]
    //@ invariant end === numbers[k - 1]
    //@ invariant start <= end
    //@ invariant forall(i: nat, i + 1 < numbers.length ==> numbers[i] < numbers[i + 1])
    //@ invariant forall(i: nat, _run <= i && i + 1 < k ==> numbers[i] + 1 === numbers[i + 1])
    //@ invariant forall(r: nat, r < found.length ==> found[r].start <= found[r].end)
    //@ invariant forall(r: nat, r + 1 < found.length ==> found[r].end + 1 < found[r + 1].start)
    //@ invariant found.length > 0 ==> found[found.length - 1].end + 1 < start
    //@ invariant forall(x: int, (exists(r: nat, r < found.length && found[r].start <= x && x <= found[r].end)) <==> numbers.slice(0, _run).includes(x))
    //@ invariant forall(x: int, start <= x && x <= end <==> numbers.slice(_run, k).includes(x))
    const number = numbers[k] as number;
    if (end + 1 === number) {
      end = number;
    } else {
      //@ assert end < number
      //@ assert end + 1 < number
      found.push({ start, end });
      start = number;
      end = number;
      _run = k;
    }
    k = k + 1;
  }
  found.push({ start, end });
  //@ assert forall(x: int, (exists(r: nat, r < found.length && found[r].start <= x && x <= found[r].end)) <==> numbers.includes(x))
  return found;
}

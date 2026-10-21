/** Whether a batch has Tesota's bounded number of questions. */
//@ ensures \result <==> 1 <= count && count <= 3
export function questionCountAccepted(count: number): boolean {
  return count >= 1 && count <= 3;
}

/** Whether one question has Tesota's bounded number of offered choices. */
//@ ensures \result <==> 2 <= count && count <= 4
export function optionCountAccepted(count: number): boolean {
  return count >= 2 && count <= 4;
}

/** Whether a request that already asked the operator `asked` times may ask once more. */
//@ requires asked >= 0
//@ ensures \result <==> asked < 3
export function askAccepted(asked: number): boolean {
  return asked < 3;
}

/** Whether one answer has enough input and obeys a single-choice question. */
//@ requires selected >= 0
//@ ensures \result <==> (multiple || selected <= 1) && (selected >= 1 || hasText)
export function answerAccepted(multiple: boolean, selected: number, hasText: boolean): boolean {
  return (multiple || selected <= 1) && (selected >= 1 || hasText);
}

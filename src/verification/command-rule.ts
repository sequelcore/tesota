/**
 * Decision 049's rules for commands on this computer. The operator may save
 * a rule, the leading words of a command, so that later commands beginning
 * with them run without asking. A rule names a program and at least one of
 * its words, and never starts with a program that runs whatever it is given,
 * such as a shell or an interpreter, or that deletes; those are passed as
 * `forbidden`. A command runs without asking only when it could be split
 * into plain parts, and every part begins with some saved rule, so no part
 * of it goes unasked.
 */

/** Whether a command part's words begin with a rule's words. */
//@ ensures \result === (rule.length > 0 && rule.length <= words.length && forall(i: nat, i < rule.length ==> rule[i] === words[i]))
export function beginsWith(words: string[], rule: string[]): boolean {
  if (rule.length === 0 || rule.length > words.length) return false;
  let i = 0;
  while (i < rule.length) {
    //@ invariant 0 <= i && i <= rule.length
    //@ invariant forall(j: nat, j < i ==> rule[j] === words[j])
    if (rule[i] !== words[i]) return false;
    i = i + 1;
  }
  return true;
}

/** Whether a rule may be saved: two words or more, not starting with a forbidden program. */
//@ ensures \result === (rule.length >= 2 && forall(i: nat, i < forbidden.length ==> forbidden[i] !== rule[0]))
export function savableRule(rule: string[], forbidden: string[]): boolean {
  if (rule.length < 2) return false;
  let i = 0;
  while (i < forbidden.length) {
    //@ invariant 0 <= i && i <= forbidden.length
    //@ invariant forall(j: nat, j < i ==> forbidden[j] !== rule[0])
    if (forbidden[i] === rule[0]) return false;
    i = i + 1;
  }
  return true;
}

/** Whether some saved rule begins a command part. */
//@ ensures \result === exists(r: nat, r < rules.length && rules[r].length > 0 && rules[r].length <= words.length && forall(i: nat, i < rules[r].length ==> rules[r][i] === words[i]))
export function coveredPart(words: string[], rules: string[][]): boolean {
  for (const rule of rules) {
    //@ invariant forall(k: nat, k < _rule_idx ==> !(rules[k].length > 0 && rules[k].length <= words.length && forall(i: nat, i < rules[k].length ==> rules[k][i] === words[i])))
    if (beginsWith(words, rule)) return true;
  }
  return false;
}

/**
 * Whether a command runs on this computer without asking: it split into plain
 * parts, it has at least one, and some saved rule begins every part.
 * `parts[q].length >= 0` always holds; it names each part's words where the
 * prover can match them.
 */
//@ ensures \result === (plain && parts.length > 0 && forall(q: nat, q < parts.length ==> parts[q].length >= 0 && exists(r: nat, r < rules.length && rules[r].length > 0 && rules[r].length <= parts[q].length && forall(i: nat, i < rules[r].length ==> rules[r][i] === parts[q][i]))))
export function runsWithoutAsking(plain: boolean, parts: string[][], rules: string[][]): boolean {
  if (!plain || parts.length === 0) return false;
  for (const part of parts) {
    //@ invariant forall(k: nat, k < _part_idx ==> parts[k].length >= 0 && exists(r: nat, r < rules.length && rules[r].length > 0 && rules[r].length <= parts[k].length && forall(i: nat, i < rules[r].length ==> rules[r][i] === parts[k][i])))
    if (!coveredPart(part, rules)) return false;
  }
  return true;
}

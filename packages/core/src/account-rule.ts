/**
 * Which of the models a setting or agent type names keep the account `id`
 * (#642): `named[i]` is the provider part of one such `provider/id` model,
 * and it uses the account exactly when it is that account's provider ID. An
 * account is removed only when none uses it, so a removal never leaves a
 * setting or agent type naming an account that is gone.
 */
//@ ensures \result.length === named.length
//@ ensures forall(i: nat, i < named.length ==> (\result[i] <==> named[i] === id))
export function accountUses(named: readonly string[], id: string): boolean[] {
  const uses: boolean[] = [];
  let i = 0;
  while (i < named.length) {
    //@ invariant 0 <= i && i <= named.length && uses.length === i
    //@ invariant forall(k: nat, k < i ==> (uses[k] <==> named[k] === id))
    uses.push(named[i] === id);
    i = i + 1;
  }
  return uses;
}

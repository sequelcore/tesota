/**
 * Whether a skill may be started (#540), by the model on its own choice or
 * by the operator by name, from its frontmatter as Claude Code reads it: the
 * model unless `disable-model-invocation: true`, the operator unless
 * `user-invocable: false`. Each field limits only its own starter.
 */
//@ ensures byModel ==> (\result <==> !disableModelInvocation)
//@ ensures !byModel ==> (\result <==> userInvocable)
export function mayStart(byModel: boolean, disableModelInvocation: boolean, userInvocable: boolean): boolean {
  if (byModel) return !disableModelInvocation;
  return userInvocable;
}

/**
 * Issue #253's rule for a message the reviewer attaches to an earlier request
 * rather than counting it as one, such as "continue" after a stopped turn or
 * "ask again" after a declined command. The attachment stands only when the
 * message is a later request than the one it continues, both exist, and the
 * reviewer gave the message no obligations of its own: its words are judged
 * under the request it continues, so attaching it never drops what it asks.
 */
//@ requires requests >= 0 && ownObligations >= 0
//@ ensures \result <==> (continues >= 1 && continues < index && index <= requests && ownObligations === 0)
export function continuationAccepted(index: number, continues: number, requests: number, ownObligations: number): boolean {
  if (continues < 1 || continues >= index || index > requests) return false;
  return ownObligations === 0;
}

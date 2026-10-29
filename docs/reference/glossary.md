# Glossary

Use this table when reading a receipt or the documentation. For example,
a design model check produces evidence about the design model; the model
that writes the code is an LLM.

| Term | Meaning |
| --- | --- |
| request | What you ask Tesota to do |
| run | The agent's work on a request, then its verification, ending in a receipt |
| receipt | The record of what was verified and what wasn't, at the end of each run |
| standing | How a run ended: verified, incomplete, unverified, unchanged (shown in print mode as `Completed (nothing to verify)`) or failed |
| verification | What Tesota does after the agent finishes: proofs, tests, model checks, weakening checks |
| proof | A LemmaScript contract proved with Dafny in LemmaScript's model of TypeScript; JavaScript runtime behavior, including floating-point rounding, can differ. See [What a proof covers](checks.md#proofs) |
| design model | A TLA+ or Quint model checked with TLC; a pass establishes the declared properties in every reachable state as configured. Apalache translates Quint for TLC |
| model | The LLM the agent runs on (`provider/model`) |
| model graph | The states a model checker explored, shown by `/graph` |
| account | A named sign-in (`claude-code@name`, `openai-codex@name`) |
| session | A conversation in one folder, with its runs, saved and resumable |
| base | The commit or private snapshot recorded when your request starts |
| contract | The written preconditions and postconditions a proof checks against a function |
| evidence | A check's recorded claim, limits, outcome and output, bound to listed files by a content hash |
| invariant | A property checked in every reachable state of the design model as configured |
| planted fault | A deliberately faulty design model variant that should break a declared property |
| counterexample | The steps a model checker reports leading to a broken property |
| mutation | A small change to a function's body used to test its contract's strength |
| survivor | A mutation that still proves and has not been proved equivalent to the original |
| exercise | Checking whether a changed or added test fails on the starting code and passes with the change |
| inherited change | A path already dirty at the first capture whose content stays unchanged during the request |
| unit | A repository or snapshot folder with its own base, checks and evidence in a multi-folder receipt |
| workspace | The checkout or Git worktree in which a session's tools and checks run |
| weakening flag | A diff-based warning that a change may reduce what proofs or tests establish |
| open case | An input for which a model suggests your request leaves more than one reasonable result |
| ClaimCheck | The model-based comparison between a contract's restatement and your request |
| code evidence | What checks establish about the changed code: proofs, project tests, exercise, design models, and the changed lines none covers. Never that every requirement was checked |
| specification evidence | What mechanical checks establish about the checks themselves: contract strength, vacuous proofs and weakening flags. Never that the specification captures your request |
| request review | A model's opinion of whether changed contracts match your request: ClaimCheck and open cases. Never verification evidence, and never a gate or a repair |
| contract strength | Whether the generated mutations of a function break its contract's proof, apart from those proved equivalent. Never that the contract is complete |

A read-only run or a run with no observed change may end without a receipt.
See [How verification works](../concepts/verification.md) for the process
and [Receipt v2](../receipt-v2.md) for stored field names and types.

-------------------------- MODULE QuestionTurn --------------------------
(* tesota-model
   covers: packages/core/src/loop.ts questionHost outcomeOf runCalls repairQuestion turns settle
   covers: packages/core/src/questions-rule.ts askAccepted questionRepair
   covers: packages/core/src/settle-rule.ts afterExtensions afterVerifier
   confirmed: 394ed0beb897eb38b81c3433a48af157be14392b
   invariant: Bounds, WaitingIsOpen, CompletionNeedsVerification
   atomic: call admission and attempt increment; saved answer and release; terminal settlement and receipt; queued input delivery
   omits: question text recognition, file contents and fingerprints, hooks, jobs, storage failures, process death, terminal key delivery and part 5 stop races; base is an opaque stable token
   fault: models/QuestionTurn-reset.cfg amendment resets the request question budget
   fault: models/QuestionTurn-wait.cfg settlement verifies a still-pending native question
*)
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, attempts, total, repaired, repairs, admitted, pending, receipt, verified, responder, base
vars == <<phase, attempts, total, repaired, repairs, admitted, pending, receipt, verified, responder, base>>
Init == /\ phase = "generate" /\ attempts = 0 /\ total = 0
        /\ repaired = FALSE /\ repairs = 0 /\ admitted = 0 /\ pending = FALSE
        /\ receipt = FALSE /\ verified = FALSE /\ responder \in BOOLEAN /\ base = "admission"

Ask == /\ phase = "generate"
       /\ IF attempts = 3
          THEN /\ phase' = "finalize" /\ UNCHANGED <<attempts, total, admitted, pending>>
          ELSE /\ attempts' = attempts + 1 /\ total' = total + 1
               /\ IF responder
                  THEN /\ phase' = "waiting" /\ pending' = TRUE /\ admitted' = admitted + 1
                  ELSE /\ phase' = "finalize" /\ UNCHANGED <<pending, admitted>>
       /\ UNCHANGED <<repaired, repairs, receipt, verified, responder, base>>
Invalid == /\ phase = "generate"
           /\ IF attempts = 3
              THEN /\ phase' = "finalize" /\ UNCHANGED <<attempts, total, repaired, repairs>>
              ELSE /\ attempts' = attempts + 1 /\ total' = total + 1
                   /\ IF repaired \/ ~responder \/ attempts' = 3
                      THEN /\ phase' = "finalize" /\ UNCHANGED <<repaired, repairs>>
                      ELSE /\ repaired' = TRUE /\ repairs' = repairs + 1 /\ phase' = "generate"
           /\ UNCHANGED <<admitted, pending, receipt, verified, responder, base>>
Prose == /\ phase = "generate"
         /\ IF repaired \/ ~responder \/ attempts = 3
            THEN /\ phase' = "finalize" /\ UNCHANGED <<repaired, repairs>>
            ELSE /\ repaired' = TRUE /\ repairs' = repairs + 1 /\ phase' = "generate"
         /\ UNCHANGED <<attempts, total, admitted, pending, receipt, verified, responder, base>>
Answer == /\ phase = "waiting" /\ phase' = "generate" /\ pending' = FALSE
          /\ UNCHANGED <<attempts, total, repaired, repairs, admitted, receipt, verified, responder, base>>
AmendOrCompact == /\ phase \in {"generate", "waiting", "verify"}
                  /\ attempts' = IF Fault = "ResetBudget" THEN 0 ELSE attempts
                  /\ UNCHANGED <<phase, total, repaired, repairs, admitted, pending, receipt, verified, responder, base>>
End == /\ (phase = "generate" \/ (Fault = "VerifyWaiting" /\ phase = "waiting"))
       /\ phase' = "verify"
       /\ UNCHANGED <<attempts, total, repaired, repairs, admitted, pending, receipt, verified, responder, base>>
Verify == /\ phase = "verify" /\ verified' = TRUE /\ phase' = "settled"
          /\ UNCHANGED <<attempts, total, repaired, repairs, admitted, pending, receipt, responder, base>>
Continue == /\ phase = "settled" /\ phase' = "generate" /\ verified' = FALSE
            /\ UNCHANGED <<attempts, total, repaired, repairs, admitted, pending, receipt, responder, base>>
Complete == /\ phase = "settled" /\ phase' = "completed" /\ receipt' = TRUE
            /\ UNCHANGED <<attempts, total, repaired, repairs, admitted, pending, verified, responder, base>>
Finalize == /\ phase = "finalize" /\ phase' = "incomplete" /\ receipt' = TRUE
            /\ UNCHANGED <<attempts, total, repaired, repairs, admitted, pending, verified, responder, base>>
Done == /\ phase \in {"completed", "incomplete"} /\ UNCHANGED vars
Next == Ask \/ Invalid \/ Prose \/ Answer \/ AmendOrCompact \/ End \/ Verify \/ Continue \/ Complete \/ Finalize \/ Done
Spec == Init /\ [][Next]_vars
Bounds == attempts <= 3 /\ total <= 3 /\ admitted <= 3 /\ repairs <= 1 /\ base = "admission"
WaitingIsOpen == pending => (phase = "waiting" /\ ~receipt /\ ~verified)
CompletionNeedsVerification == phase = "completed" => verified /\ receipt /\ ~pending
=============================================================================

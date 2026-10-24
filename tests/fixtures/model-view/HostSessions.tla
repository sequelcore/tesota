--------------------------- MODULE HostSessions ---------------------------
EXTENDS Naturals
(* Round 2 research fixture, authored here. Not Tesota's implementation.
   Deliberate fault: Park fails to require an idle session.
   @view groupBy: host, session   (prototype sidecar, not a TLC directive) *)
VARIABLES host, session, age, jobs
vars == <<host, session, age, jobs>>
Init == /\ host = "active" /\ session = "idle" /\ age = 0 /\ jobs = 0
Request == /\ host = "active" /\ session = "idle"
           /\ session' = "job" /\ jobs' = (jobs + 1) % 4
           /\ UNCHANGED <<host, age>>
StartTask == /\ host = "active" /\ session = "job"
             /\ session' = "task" /\ UNCHANGED <<host, age, jobs>>
FinishTask == /\ host = "active" /\ session = "task"
              /\ session' = "idle" /\ UNCHANGED <<host, age, jobs>>
Sweep == /\ host = "active" /\ host' = "reaping" /\ UNCHANGED <<session, age, jobs>>
Keep == /\ host = "reaping" /\ host' = "active" /\ UNCHANGED <<session, age, jobs>>
Park == /\ host \in {"active", "reaping"} /\ host' = "parked"
        /\ UNCHANGED <<session, age, jobs>>
Wake == /\ host = "parked" /\ host' = "active" /\ UNCHANGED <<session, age, jobs>>
Checkpoint == /\ host = "parked" /\ host' = "checkpoint" /\ UNCHANGED <<session, age, jobs>>
Hold == /\ host = "checkpoint" /\ session = "task" /\ session' = "waiting"
        /\ UNCHANGED <<host, age, jobs>>
Complete == /\ host = "checkpoint" /\ host' = "active" /\ UNCHANGED <<session, age, jobs>>
Resume == /\ host = "active" /\ session = "waiting" /\ session' = "task"
          /\ UNCHANGED <<host, age, jobs>>
Tick == /\ age' = (age + 1) % 5 /\ UNCHANGED <<host, session, jobs>>
Next == Request \/ StartTask \/ FinishTask \/ Sweep \/ Keep \/ Park \/ Wake
        \/ Checkpoint \/ Hold \/ Complete \/ Resume \/ Tick
NoParkedWork == host = "parked" => session = "idle"
Spec == Init /\ [][Next]_vars
=============================================================================

(* A test fixture for the model chart (#761), not a model of Tesota's code, so
   the gate does not check it. Copied from a project's models/DnsPlans.tla; its
   DnsPlansStaleWrite.cfg plants the stale write behind dns-stale.dot. *)
---- MODULE DnsPlans ----
EXTENDS Naturals, FiniteSets
CONSTANTS MaxGen, Keep, Guard, WriteGuard

VARIABLES plans, published, active, pending, cursor, highWater
vars == <<plans, published, active, pending, cursor, highWater>>
Enactors == {1, 2}
Endpoints == 1..2

Max(S) == CHOOSE x \in S : \A y \in S : x >= y

Init == /\ plans = {}
        /\ published = 0
        /\ active = [ep \in Endpoints |-> 0]
        /\ pending = [e \in Enactors |-> 0]
        /\ cursor = [e \in Enactors |-> 1]
        /\ highWater = [ep \in Endpoints |-> 0]

Publish == /\ published < MaxGen
           /\ published' = published + 1
           /\ plans' = plans \cup {published + 1}
           /\ UNCHANGED <<active, pending, cursor, highWater>>

\* Capture the newest plan before waiting. Other enactors and the planner
\* can run arbitrarily many steps before this enactor writes either endpoint.
Select(e) == /\ pending[e] = 0
             /\ plans # {}
             /\ (WriteGuard \/ Max(plans) > active[1])
             /\ pending' = [pending EXCEPT ![e] = Max(plans)]
             /\ cursor' = [cursor EXCEPT ![e] = 1]
             /\ UNCHANGED <<plans, published, active, highWater>>

\* The pause/retry is BEFORE this action, not inside its atomic boundary.
Point(e) == /\ pending[e] # 0
            /\ cursor[e] \in Endpoints
            /\ LET ep == cursor[e]
                   g == pending[e]
                   allowed == ~WriteGuard \/ (g \in plans /\ g > active[ep])
               IN /\ active' = IF allowed THEN [active EXCEPT ![ep] = g] ELSE active
                  /\ highWater' = IF allowed /\ g > highWater[ep]
                                    THEN [highWater EXCEPT ![ep] = g] ELSE highWater
            /\ cursor' = [cursor EXCEPT ![e] = @ + 1]
            /\ UNCHANGED <<plans, published, pending>>

Cleanup(e) == /\ pending[e] # 0
              /\ cursor[e] = 3
              /\ plans' = IF Guard
                            THEN {p \in plans : p >= pending[e] - Keep}
                            ELSE {p \in plans : p > pending[e]}
              /\ pending' = [pending EXCEPT ![e] = 0]
              /\ UNCHANGED <<published, active, cursor, highWater>>

\* A rejected pause aborts apply without cleanup; a later run can retry.
Abort(e) == /\ pending[e] # 0
            /\ cursor[e] \in Endpoints
            /\ pending' = [pending EXCEPT ![e] = 0]
            /\ UNCHANGED <<plans, published, active, cursor, highWater>>

Next == Publish \/ (\E e \in Enactors : Select(e) \/ Point(e) \/ Cleanup(e) \/ Abort(e))

EndpointHasPlan == \A ep \in Endpoints : active[ep] = 0 \/ active[ep] \in plans
EndpointNeverRegresses == active = highWater
Safety == EndpointHasPlan /\ EndpointNeverRegresses
====

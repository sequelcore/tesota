---------------------------- MODULE Lights ----------------------------
EXTENDS Naturals
(* Viewer test fixture: a lamp that may be left lit when the door locks.
   @view groupBy: door, lamp *)
VARIABLES door, lamp, n
Init == door = "open" /\ lamp = "off" /\ n = 0
Switch == /\ lamp' = (IF lamp = "on" THEN "off" ELSE "on") /\ UNCHANGED <<door, n>>
Lock == door = "open" /\ door' = "locked" /\ UNCHANGED <<lamp, n>>
Unlock == door = "locked" /\ door' = "open" /\ n' = (n + 1) % 2 /\ UNCHANGED lamp
Next == Switch \/ Lock \/ Unlock
DarkWhenLocked == door = "locked" => lamp = "off"
=============================================================================

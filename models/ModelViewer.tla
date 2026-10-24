---------------------------- MODULE ModelViewer ----------------------------
(* tesota-model
   covers: packages/core/src/shell/model-viewer.ts ModelViewer.dispose #load
   covers: packages/core/src/shell/shell.ts stop overlay
   confirmed: 94af4432
   invariant: ClosedWorkersCancelled
   atomic: start or replace load; deliver worker completion; dispose overlay on shutdown
   omits: process termination latency and OS reaping, graph content, terminal rendering, dialogs
   fault: models/ModelViewer-no-dispose.cfg shutdown omits overlay disposal
*)
EXTENDS Naturals, FiniteSets
CONSTANT DisposeOnStop
VARIABLES closed, active, aborted, next
vars == <<closed, active, aborted, next>>
Init == /\ closed = FALSE /\ active = {} /\ aborted = {} /\ next = 0
Load == /\ ~closed /\ next < 3
        /\ aborted' = aborted \cup active
        /\ active' = {next} /\ next' = next + 1 /\ UNCHANGED closed
Complete == /\ active # {} /\ active' = {} /\ UNCHANGED <<closed, aborted, next>>
Stop == /\ ~closed /\ closed' = TRUE
        /\ aborted' = IF DisposeOnStop THEN aborted \cup active ELSE aborted
        /\ UNCHANGED <<active, next>>
Next == Load \/ Complete \/ Stop
ClosedWorkersCancelled == closed => active \subseteq aborted
Spec == Init /\ [][Next]_vars
=============================================================================

-------------------------- MODULE ProviderRetry --------------------------
(* tesota-model
   covers: packages/core/src/loop.ts streamed streamedOnce
   covers: packages/core/src/provider-retry-rule.ts retryProviderCall
   confirmed: 82f043318dcb0c576c992f314cd17da7788fb3f9
   invariant: Bounds, CancelStopsCalls, WaitRespected, ToolsAndRouteStay
   atomic: failure classification and scheduling; cancellation signal; post-wait guard and model-call start
   omits: HTTP and text classification, real clock precision, stream contents, usage, persistence and settlement; seconds represent the millisecond window, with representative waits and scheduler overshoot; starts after one tool result and the first failed model call
   fault: models/ProviderRetry-no-cancel.cfg post-wait guard ignores cancellation
   fault: models/ProviderRetry-replay-tool.cfg a retry replays the completed tool
*)
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, time, due, retries, calls, stopped, callsAtStop, terminal, lastStart, lastDue, tools, route
vars == <<phase, time, due, retries, calls, stopped, callsAtStop, terminal, lastStart, lastDue, tools, route>>
Init == /\ phase = "failed" /\ time = 0 /\ due = 0 /\ retries = 0 /\ calls = 1
        /\ stopped = FALSE /\ callsAtStop = 0 /\ terminal \in BOOLEAN
        /\ lastStart = 0 /\ lastDue = 0 /\ tools = 1 /\ route = "chosen"
Schedule == /\ phase = "failed"
            /\ \E delay \in {1, 60, 121}:
                 IF ~terminal /\ ~stopped /\ retries < 3 /\ time + delay < 120
                 THEN /\ phase' = "waiting" /\ due' = time + delay /\ retries' = retries + 1
                 ELSE /\ phase' = "ended" /\ UNCHANGED <<due, retries>>
            /\ UNCHANGED <<time, calls, stopped, callsAtStop, terminal, lastStart, lastDue, tools, route>>
Advance == /\ phase = "waiting" /\ time < 120
           /\ time' \in {due, 120} /\ time' >= time
           /\ UNCHANGED <<phase, due, retries, calls, stopped, callsAtStop, terminal, lastStart, lastDue, tools, route>>
Cancel == /\ ~stopped /\ phase \in {"failed", "waiting", "calling"}
          /\ stopped' = TRUE /\ callsAtStop' = calls
          /\ UNCHANGED <<phase, time, due, retries, calls, terminal, lastStart, lastDue, tools, route>>
StartCall == /\ phase = "waiting" /\ time >= due /\ time < 120
             /\ (~stopped \/ Fault = "IgnoreCancel")
             /\ phase' = "calling" /\ calls' = calls + 1
             /\ lastStart' = time /\ lastDue' = due
             /\ tools' = IF Fault = "ReplayTool" THEN tools + 1 ELSE tools
             /\ UNCHANGED <<time, due, retries, stopped, callsAtStop, terminal, route>>
StopWait == /\ phase = "waiting" /\ (stopped \/ time >= 120)
            /\ phase' = "ended"
            /\ UNCHANGED <<time, due, retries, calls, stopped, callsAtStop, terminal, lastStart, lastDue, tools, route>>
Failure == /\ phase = "calling" /\ phase' = "failed" /\ terminal' \in BOOLEAN
           /\ UNCHANGED <<time, due, retries, calls, stopped, callsAtStop, lastStart, lastDue, tools, route>>
Success == /\ phase = "calling" /\ phase' = "ended"
           /\ UNCHANGED <<time, due, retries, calls, stopped, callsAtStop, terminal, lastStart, lastDue, tools, route>>
Done == /\ phase = "ended" /\ UNCHANGED vars
Next == Schedule \/ Advance \/ Cancel \/ StartCall \/ StopWait \/ Failure \/ Success \/ Done
Spec == Init /\ [][Next]_vars
Bounds == retries <= 3 /\ calls <= 4 /\ lastStart < 120
CancelStopsCalls == stopped => calls = callsAtStop
WaitRespected == lastStart >= lastDue
ToolsAndRouteStay == tools = 1 /\ route = "chosen"
=============================================================================

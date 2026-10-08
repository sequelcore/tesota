import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tesota's Pi extension. For now it only marks the session as running with Tesota. */
export default function tesota(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("tesota", "Tesota");
  });
}

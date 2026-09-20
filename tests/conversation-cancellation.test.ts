import { expect, it } from "vitest";
import { runRepositoryConversationForShell } from "../src/conversation-turn.js";

it("honors retained shell cancellation before repository discovery starts", async () => {
  const cancellation = new AbortController();
  cancellation.abort();

  await expect(runRepositoryConversationForShell(
    { request: "Inspect the repository" },
    () => {},
    cancellation.signal,
  )).resolves.toEqual({ status: "cancelled", exitCode: 130, settlement: "observed" });
});

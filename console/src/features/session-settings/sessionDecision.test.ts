import { beforeEach, expect, it, vi } from "vitest";
import { request } from "@/api/request";
import {
  clearPendingDecision,
  loadDecisionSettings,
  readPendingDecision,
  saveDecisionSettings,
  withPendingDecision,
} from "./sessionDecision";
import {
  migratePendingSessionSettings,
  withPendingSessionSettings,
} from "./pendingSessionSettings";

vi.mock("@/api/request", () => ({ request: vi.fn() }));
const inherited = { configured: true, enabled: true, override: null };
beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  vi.mocked(request).mockResolvedValue(inherited);
});

it("reads agent defaults without copying them into a new conversation", async () => {
  const scope = { sessionId: "new" };
  expect(await loadDecisionSettings("a", scope)).toEqual(inherited);
  expect(request).toHaveBeenLastCalledWith("/chats/decision-settings", {
    headers: { "X-Agent-Id": "a" },
  });
  expect(readPendingDecision("a", "new")).toBeNull();
  vi.mocked(request).mockResolvedValue({
    configured: false,
    enabled: false,
    override: null,
  });
  expect((await loadDecisionSettings("a", scope)).enabled).toBe(false);
  expect(withPendingDecision({}, "a", "new")).toEqual({});
});

it.each([false, true])(
  "carries %s through first-send allocation until the stored override is acknowledged",
  async (enabled) => {
    const chosen = { configured: true, enabled, override: enabled };
    vi.mocked(request).mockResolvedValue(chosen);
    await saveDecisionSettings("a", { sessionId: "new" }, enabled);
    expect(request).toHaveBeenLastCalledWith("/chats/decision-settings", {
      method: "PUT",
      headers: { "X-Agent-Id": "a" },
      body: JSON.stringify(enabled),
    });
    expect(readPendingDecision("b", "new")).toBeNull();
    migratePendingSessionSettings("a", "new", "created");
    expect(withPendingSessionSettings({}, "a", "created").requestBody).toEqual({
      request_context: { session_decision_enabled: enabled },
    });
    const scope = { sessionId: "created", chatId: "chat" };
    vi.mocked(request).mockResolvedValueOnce(inherited);
    expect(await loadDecisionSettings("a", scope)).toEqual(chosen);
    // An equal effective value does not acknowledge an unpersisted override.
    expect(readPendingDecision("a", "created")).toBe(enabled);
    expect(request).toHaveBeenLastCalledWith(
      "/chats/decision-settings?chat_id=chat",
      { headers: { "X-Agent-Id": "a" } },
    );
    await loadDecisionSettings("a", scope);
    expect(readPendingDecision("a", "created")).toBeNull();
    expect(withPendingDecision({}, "a", "created")).toEqual({});
  },
);

it("uses backend resolution for a draft even after the agent model is removed", async () => {
  await saveDecisionSettings("a", { sessionId: "new" }, true);
  const unavailable = { configured: false, enabled: false, override: true };
  vi.mocked(request).mockResolvedValue(unavailable);
  expect(await loadDecisionSettings("a", { sessionId: "new" })).toEqual(
    unavailable,
  );
  expect(request).toHaveBeenLastCalledWith("/chats/decision-settings", {
    headers: { "X-Agent-Id": "a" },
  });
});

it("preserves the draft on a failed save and clears it after a persisted update", async () => {
  const scope = { sessionId: "s", chatId: "chat" };
  await saveDecisionSettings("a", { sessionId: "s" }, true);
  vi.mocked(request).mockRejectedValueOnce(new Error("offline"));
  await expect(saveDecisionSettings("a", scope, false)).rejects.toThrow(
    "offline",
  );
  expect(readPendingDecision("a", "s")).toBe(true);
  expect(await saveDecisionSettings("a", scope, false)).toEqual(inherited);
  expect(request).toHaveBeenLastCalledWith("/chats/chat/decision-settings", {
    method: "PUT",
    headers: { "X-Agent-Id": "a" },
    body: "false",
  });
  expect(readPendingDecision("a", "s")).toBeNull();
  clearPendingDecision("a", "new");
});

it("does not save an invalid draft when the backend rejects enabling it", async () => {
  vi.mocked(request).mockRejectedValueOnce(
    new Error("No decision model configured"),
  );
  await expect(
    saveDecisionSettings("a", { sessionId: "new" }, true),
  ).rejects.toThrow();
  expect(readPendingDecision("a", "new")).toBeNull();
});

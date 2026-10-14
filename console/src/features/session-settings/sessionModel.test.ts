import { setPendingThinking, readPendingThinking } from "./pendingThinking";
import { beforeEach, expect, it, vi } from "vitest";
import { request } from "@/api/request";
import {
  loadSessionModel,
  resetSessionModel,
  saveSessionModel,
  migratePendingModel,
  readPendingModel,
  withPendingModel,
  loadSessionDecisionModel,
  saveSessionDecisionModel,
  clearPendingModel,
} from "./sessionModel";
vi.mock("@/api/request", () => ({ request: vi.fn() }));
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
});

it("migrates both choices and only retires the acknowledged decision model", async () => {
  const chat = { provider_id: "p", model: "chat" };
  const decision = { provider_id: "p", model: "decision" };
  vi.mocked(request).mockResolvedValue(chat);
  await saveSessionModel("a", { sessionId: "new" }, chat);
  vi.mocked(request).mockResolvedValue(decision);
  await saveSessionDecisionModel("a", { sessionId: "new" }, decision);
  migratePendingModel("a", "new", "created");
  expect(withPendingModel({}, "a", "created")).toEqual({
    request_context: { session_model: chat, session_decision_model: decision },
  });
  const scope = { sessionId: "created", chatId: "created" };
  vi.mocked(request)
    .mockResolvedValueOnce({ model: null })
    .mockResolvedValueOnce(decision);
  expect(await loadSessionDecisionModel("a", scope)).toEqual(decision);
  expect(readPendingModel("a", "created", "decision")).toEqual(decision);
  vi.mocked(request).mockResolvedValueOnce({
    ...decision,
    model_source: "session",
  });
  await loadSessionDecisionModel("a", scope);
  expect(readPendingModel("a", "created", "decision")).toBeNull();
  expect(readPendingModel("a", "created")).toEqual(chat);
});

it("keeps chat and thinking overrides when resetting the decision model", async () => {
  const chat = { provider_id: "p", model: "chat" };
  vi.mocked(request).mockResolvedValue(chat);
  const scope = { sessionId: "new" };
  await saveSessionModel("a", scope, chat);
  await saveSessionDecisionModel("a", scope, {
    provider_id: "p",
    model: "decision",
  });
  setPendingThinking("a", "new", { level: "high" }, "p:chat");
  await saveSessionDecisionModel("a", scope, null);
  expect(readPendingModel("a", "new", "decision")).toBeNull();
  expect(readPendingModel("a", "new")).toEqual(chat);
  expect(readPendingThinking("a", "new", "p:chat")).toEqual({ level: "high" });
});

it("clears both pending types for a fresh conversation", async () => {
  vi.mocked(request).mockResolvedValue({ model: "m" });
  await saveSessionModel(
    "a",
    { sessionId: "new" },
    { provider_id: "p", model: "m" },
  );
  await saveSessionDecisionModel(
    "a",
    { sessionId: "new" },
    { provider_id: "p", model: "d" },
  );
  clearPendingModel("a", "new");
  expect(withPendingModel({}, "a", "new")).toEqual({});
});

it("uses the typed session endpoint and retains the selection after a failed save", async () => {
  const decision = { provider_id: "p", model: "d" };
  vi.mocked(request).mockResolvedValue(decision);
  await saveSessionDecisionModel("a", { sessionId: "s" }, decision);
  vi.mocked(request).mockRejectedValueOnce(new Error("offline"));
  await expect(
    saveSessionDecisionModel("a", { sessionId: "s", chatId: "c" }, null),
  ).rejects.toThrow("offline");
  expect(request).toHaveBeenLastCalledWith(
    "/chats/c/model?model_type=decision",
    {
      method: "PUT",
      body: "null",
      headers: { "X-Agent-Id": "a" },
    },
  );
  expect(readPendingModel("a", "s", "decision")).toEqual(decision);
});
it("persists existing-session selection without changing agent defaults", async () => {
  vi.mocked(request).mockResolvedValue({
    provider_id: "p",
    model: "m",
    effective_max_input_length: 32000,
  });
  const scope = { sessionId: "s", chatId: "chat-a" };
  await saveSessionModel("agent", scope, { provider_id: "p", model: "m" });
  expect(request).toHaveBeenCalledWith(
    "/chats/chat-a/model",
    expect.objectContaining({
      method: "PUT",
      headers: { "X-Agent-Id": "agent" },
    }),
  );
  expect((await loadSessionModel("agent", scope)).active_llm?.model).toBe("m");
  expect(request).toHaveBeenLastCalledWith(
    "/chats/chat-a/thinking",
    expect.anything(),
  );
});
it("carries new-session model selection through first-send allocation", async () => {
  vi.mocked(request).mockResolvedValue({ provider_id: "p", model: "m" });
  await saveSessionModel(
    "a",
    { sessionId: "new" },
    { provider_id: "p", model: "m" },
  );
  expect(readPendingModel("b", "new")).toBeNull();
  migratePendingModel("a", "new", "created");
  expect(readPendingModel("a", "new")).toBeNull();
  expect(
    withPendingModel({ request_context: { other: true } }, "a", "created"),
  ).toEqual({
    request_context: {
      other: true,
      session_model: { provider_id: "p", model: "m" },
    },
  });
});

it("keeps the submitted model visible until the allocated chat acknowledges it", async () => {
  const selected = { provider_id: "dashscope", model: "deepseek-v4.1-flash" };
  const inherited = { provider_id: "dashscope", model: "glm-5.3" };
  vi.mocked(request).mockResolvedValueOnce(selected);
  await saveSessionModel("agent", { sessionId: "new" }, selected);
  migratePendingModel("agent", "new", "created");
  const scope = { sessionId: "created", chatId: "created" };
  vi.mocked(request)
    .mockResolvedValueOnce(inherited)
    .mockResolvedValueOnce(selected);
  expect((await loadSessionModel("agent", scope)).active_llm).toEqual(selected);
  expect(readPendingModel("agent", "created")).toEqual(selected);
  expect(withPendingModel({}, "agent", "created")).toEqual({
    request_context: { session_model: selected },
  });
  vi.mocked(request).mockResolvedValueOnce({
    ...selected,
    model_source: "session",
  });
  expect((await loadSessionModel("agent", scope)).active_llm).toEqual(selected);
  expect(readPendingModel("agent", "created")).toBeNull();
  expect(withPendingModel({}, "agent", "created")).toEqual({});
});

it.each(["replace", "reset"])(
  "retires the migrated choice after a successful %s",
  async (operation) => {
    const selected = { provider_id: "dashscope", model: "deepseek-v4.1-flash" };
    vi.mocked(request).mockResolvedValue(selected);
    await saveSessionModel("agent", { sessionId: "new" }, selected);
    migratePendingModel("agent", "new", "created");
    const scope = { sessionId: "created", chatId: "created" };
    if (operation === "reset") await resetSessionModel("agent", scope);
    else
      await saveSessionModel("agent", scope, {
        provider_id: "dashscope",
        model: "glm-5.3",
      });
    expect(withPendingModel({}, "agent", "created")).toEqual({});
  },
);

it.each([null, "chat"])(
  "reset clears model and thinking pending overrides together (chat=%s)",
  async (chatId) => {
    sessionStorage.setItem("composer-draft", "keep text and attachments");
    setPendingThinking("agent", "session", { level: "high" }, "p:m");
    await resetSessionModel("agent", { sessionId: "session", chatId });
    expect(readPendingThinking("agent", "session", "p:m")).toBeNull();
    expect(sessionStorage.getItem("composer-draft")).toBe(
      "keep text and attachments",
    );
  },
);

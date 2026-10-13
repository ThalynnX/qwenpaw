import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import api, { type ChatSpec } from "../../../api";
import { ApiError } from "../../../api/request";
import { menuRegistry } from "../../../plugins/registry/store";
import { useAgentStore } from "../../../stores/agentStore";
import {
  syncSessionsGlobal,
  useSessionListStore,
} from "../../../stores/sessionListStore";
import sessionApi from "../sessionApi";
import { useChatRouteResolution } from "./useChatRouteResolution";

const TARGET = "22222222-2222-4222-8222-222222222222";

function chat(id = TARGET): ChatSpec {
  return {
    id,
    name: "Target conversation",
    session_id: `runtime-${id}`,
    user_id: "target-user",
    channel: "console",
    created_at: null,
    updated_at: null,
  };
}

function mount(referenceId?: string) {
  return renderHook(
    ({ referenceId }: { referenceId?: string }) => {
      const { selectedAgent } = useAgentStore();
      return useChatRouteResolution(referenceId, selectedAgent);
    },
    { initialProps: { referenceId } },
  );
}

beforeEach(() => {
  sessionApi.resetForTests();
  useSessionListStore.setState({ sessions: [], _setLibrarySessions: null });
  useAgentStore.setState({ selectedAgent: "a", lastChatIdByAgent: {} });
  vi.spyOn(menuRegistry, "refresh").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat route ownership resolution", () => {
  it("activates a same-agent cold link before the session list arrives", async () => {
    const resolve = vi.spyOn(api, "resolveChat").mockResolvedValue({
      agent_id: "a",
      chat: chat(),
    });
    const { result } = mount(TARGET);

    expect(result.current.blocked).toBe(true);
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(resolve).toHaveBeenCalledWith(TARGET, {
      currentAgentId: "a",
      signal: expect.any(AbortSignal),
    });
    expect(sessionApi.getSessionIdentity(TARGET)).toMatchObject({
      chatId: TARGET,
      sessionId: `runtime-${TARGET}`,
      userId: "target-user",
      channel: "console",
    });
  });

  it("switches to the owner and retains an explicit transition target", async () => {
    vi.spyOn(api, "resolveChat").mockResolvedValue({
      agent_id: "b",
      chat: chat(),
    });
    const { result } = mount(TARGET);

    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(useAgentStore.getState().selectedAgent).toBe("b");
    expect(result.current.agentSwitchTarget.current).toEqual({
      agentId: "b",
      referenceId: TARGET,
      chatId: TARGET,
    });
    expect(sessionApi.getSessionIdentity(TARGET).sessionId).toBe(
      `runtime-${TARGET}`,
    );
    expect(useAgentStore.getState().getLastChatId("a")).toBeUndefined();
  });

  it("keeps resolved archived identity when the sidebar list excludes it", async () => {
    vi.spyOn(api, "resolveChat").mockResolvedValue({
      agent_id: "a",
      chat: { ...chat(), archived: true },
    });
    vi.spyOn(api, "listChats").mockResolvedValue([]);
    const { result } = mount(TARGET);

    await waitFor(() => expect(result.current.blocked).toBe(false));
    await sessionApi.getSessionList();

    expect(sessionApi.getSessionIdentity(TARGET).sessionId).toBe(
      `runtime-${TARGET}`,
    );
  });

  it.each([undefined, "new"])(
    "opens draft %s without resolving or creating a persisted Chat",
    (referenceId) => {
      const resolve = vi.spyOn(api, "resolveChat");
      const create = vi.spyOn(api, "createChat");
      const { result } = mount(referenceId);

      expect(result.current.blocked).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("uses an already-known Chat in the current owner epoch", () => {
    sessionApi.registerResolvedChat(chat(), sessionApi.getActiveOwner());
    const resolve = vi.spyOn(api, "resolveChat");
    const { result } = mount(TARGET);

    expect(result.current.blocked).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("re-resolves a known Chat after the sidebar excludes an archived Chat", async () => {
    const list = vi.spyOn(api, "listChats").mockResolvedValue([chat()]);
    const resolve = vi.spyOn(api, "resolveChat").mockResolvedValue({
      agent_id: "a",
      chat: { ...chat(), archived: true },
    });
    await sessionApi.getSessionList();
    const { result } = mount(TARGET);

    expect(result.current.blocked).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    list.mockResolvedValue([]);
    await act(async () => {
      syncSessionsGlobal(await sessionApi.getSessionList());
    });

    await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(result.current.error).toBeNull();
    expect(sessionApi.getSessionIdentity(TARGET).chatId).toBe(TARGET);
  });

  it("reports a deleted known Chat after the sidebar removes it", async () => {
    const list = vi.spyOn(api, "listChats").mockResolvedValue([chat()]);
    const resolve = vi
      .spyOn(api, "resolveChat")
      .mockRejectedValue(new ApiError(404, "Chat not found"));
    await sessionApi.getSessionList();
    const { result } = mount(TARGET);

    expect(result.current.blocked).toBe(false);
    list.mockResolvedValue([]);
    await act(async () => {
      syncSessionsGlobal(await sessionApi.getSessionList());
    });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(ApiError));
    expect(resolve).toHaveBeenCalledOnce();
    expect(result.current.blocked).toBe(true);
    expect(result.current.error).toMatchObject({ status: 404 });
  });

  it("ignores pending resolution after the list supplies the canonical Chat", async () => {
    let finish!: (value: { agent_id: string; chat: ChatSpec }) => void;
    const resolve = vi.spyOn(api, "resolveChat").mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    vi.spyOn(api, "listChats").mockResolvedValue([chat()]);
    const { result } = mount(TARGET);
    const signal = resolve.mock.calls[0][1]?.signal;

    await act(async () => {
      syncSessionsGlobal(await sessionApi.getSessionList());
    });

    expect(result.current.blocked).toBe(false);
    expect(signal?.aborted).toBe(true);
    await act(async () => finish({ agent_id: "b", chat: chat() }));
    expect(useAgentStore.getState().selectedAgent).toBe("a");
    expect(result.current.agentSwitchTarget.current).toBeNull();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("accepts a unique runtime alias after resolving its canonical identity", async () => {
    vi.spyOn(api, "resolveChat").mockResolvedValue({
      agent_id: "a",
      chat: chat(),
    });
    const { result } = mount(`runtime-${TARGET}`);

    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(sessionApi.getSessionIdentity(`runtime-${TARGET}`).chatId).toBe(
      TARGET,
    );
  });

  it("keeps resolving when a list refresh supplies only a runtime alias", async () => {
    const alias = `runtime-${TARGET}`;
    let finish!: (value: { agent_id: string; chat: ChatSpec }) => void;
    const resolve = vi.spyOn(api, "resolveChat").mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    vi.spyOn(api, "listChats").mockResolvedValue([chat()]);
    const { result } = mount(alias);
    const signal = resolve.mock.calls[0][1]?.signal;

    sessionApi.preferredChatId = alias;
    await act(async () => {
      syncSessionsGlobal(await sessionApi.getSessionList());
    });

    expect(result.current.blocked).toBe(true);
    expect(signal?.aborted).toBe(false);
    expect(resolve).toHaveBeenCalledOnce();
    await act(async () => finish({ agent_id: "a", chat: chat() }));
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(sessionApi.getSessionIdentity(alias).chatId).toBe(TARGET);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("resolves unknown timestamp-shaped links instead of treating them as drafts", async () => {
    const alias = "1788357954784-abc123";
    const resolve = vi.spyOn(api, "resolveChat").mockResolvedValue({
      agent_id: "a",
      chat: { ...chat(), session_id: alias },
    });
    const { result } = mount(alias);

    expect(result.current.blocked).toBe(true);
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(resolve).toHaveBeenCalledOnce();
    expect(sessionApi.getSessionIdentity(alias).chatId).toBe(TARGET);
  });

  it("forgets resolved metadata after the Chat is removed", async () => {
    vi.spyOn(api, "deleteChat").mockResolvedValue({
      success: true,
      chat_id: TARGET,
    });
    sessionApi.registerResolvedChat(chat(), sessionApi.getActiveOwner());

    await sessionApi.removeSession({ id: TARGET });

    expect(sessionApi.getSessionIdentity(TARGET).sessionId).toBe("");
  });

  it("propagates persisted-history failures for a timestamp-shaped runtime alias", async () => {
    const alias = "1788357954784-abc123";
    sessionApi.registerResolvedChat(
      { ...chat(), session_id: alias },
      sessionApi.getActiveOwner(),
    );
    const get = vi
      .spyOn(api, "getChat")
      .mockRejectedValue(new ApiError(404, "Chat not found"));

    await expect(sessionApi.getSession(alias)).rejects.toThrow(
      "Chat not found",
    );
    expect(get).toHaveBeenCalledWith(TARGET, expect.any(Object));
  });

  it("checks global IDs before adopting a known runtime alias", async () => {
    sessionApi.registerResolvedChat(
      { ...chat("chat-a"), session_id: TARGET },
      sessionApi.getActiveOwner(),
    );
    const resolve = vi.spyOn(api, "resolveChat").mockResolvedValue({
      agent_id: "b",
      chat: chat(),
    });
    const { result } = mount(TARGET);

    expect(result.current.blocked).toBe(true);
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(resolve).toHaveBeenCalledOnce();
    expect(useAgentStore.getState().selectedAgent).toBe("b");
  });

  it("checks global IDs before adopting a cached SDK display alias", async () => {
    const original = "11111111-1111-4111-8111-111111111111";
    vi.spyOn(api, "listChats").mockResolvedValue([
      { ...chat(original), session_id: TARGET },
    ]);
    sessionApi.preferredChatId = TARGET;
    await sessionApi.getSessionList();
    expect(sessionApi.getSessionIdentity(TARGET)).toMatchObject({
      sdkSessionId: TARGET,
      chatId: original,
    });
    const resolve = vi.spyOn(api, "resolveChat").mockResolvedValue({
      agent_id: "b",
      chat: chat(),
    });
    const { result } = mount(TARGET);

    expect(result.current.blocked).toBe(true);
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(resolve).toHaveBeenCalledWith(TARGET, {
      currentAgentId: "a",
      signal: expect.any(AbortSignal),
    });
    expect(useAgentStore.getState().selectedAgent).toBe("b");
    expect(sessionApi.getSessionIdentity(TARGET).chatId).toBe(TARGET);
  });

  it("keeps not-found links blocked and can retry the same reference", async () => {
    const resolve = vi
      .spyOn(api, "resolveChat")
      .mockRejectedValueOnce(new ApiError(404, "Chat not found"))
      .mockResolvedValueOnce({ agent_id: "a", chat: chat() });
    const { result } = mount(TARGET);

    await waitFor(() => expect(result.current.error).toBeInstanceOf(ApiError));
    expect(result.current.blocked).toBe(true);
    expect(useAgentStore.getState().getLastChatId("a")).toBeUndefined();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });

  it("ignores a late resolution after navigating to another link", async () => {
    let finish!: (value: { agent_id: string; chat: ChatSpec }) => void;
    const resolve = vi
      .spyOn(api, "resolveChat")
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      )
      .mockResolvedValueOnce({ agent_id: "a", chat: chat("next-chat") });
    const { result, rerender } = mount(TARGET);
    const firstSignal = resolve.mock.calls[0][1]?.signal;
    rerender({ referenceId: "next-chat" });
    await waitFor(() => expect(result.current.blocked).toBe(false));
    await act(async () => finish({ agent_id: "b", chat: chat() }));

    expect(firstSignal?.aborted).toBe(true);
    expect(useAgentStore.getState().selectedAgent).toBe("a");
    expect(sessionApi.getSessionIdentity(TARGET).sessionId).toBe("");
    expect(sessionApi.getSessionIdentity("next-chat").sessionId).toBe(
      "runtime-next-chat",
    );
  });

  it("rejects a late result from an earlier A → B → A owner epoch", async () => {
    let finish!: (value: { agent_id: string; chat: ChatSpec }) => void;
    vi.spyOn(api, "resolveChat").mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const { result } = mount(TARGET);
    sessionApi.setActiveAgent("b");
    sessionApi.setActiveAgent("a");
    await act(async () => finish({ agent_id: "b", chat: chat() }));

    expect(useAgentStore.getState().selectedAgent).toBe("a");
    expect(result.current.blocked).toBe(true);
    expect(sessionApi.getSessionIdentity(TARGET).sessionId).toBe("");
  });
});

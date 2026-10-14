import { beforeEach, describe, expect, it } from "vitest";
import { enqueuePluginSubmission } from "./pluginSubmission";
import {
  MAX_QUEUE_SIZE,
  useMessageQueueStore,
} from "../../stores/messageQueueStore";

const input = { query: "Use 8 seeds", agentId: "a", sessionId: "sdk-a" };
const context = {
  active: true,
  ready: true,
  agentId: "a",
  currentSessionId: "chat-a",
  queueKey: "chat-a",
  resolveIdentity: (id: string) => ({
    sessionId: ["sdk-a", "chat-a"].includes(id) ? "backend-a" : "backend-b",
    userId: "user",
    channel: "console",
  }),
  prepareQuery: (query: string) => query,
  requestContext: { approval_level: "default" },
  queueFullMessage: "Queue full",
};

beforeEach(() => {
  useMessageQueueStore.setState({
    queues: {},
    runStates: {},
    currentSendingId: null,
  });
  localStorage.clear();
});

describe("plugin queue admission", () => {
  it("captures one complete route and request identity without consuming drafts", () => {
    localStorage.setItem("draft", "unsubmitted composer text and attachments");
    enqueuePluginSubmission(input, context);
    const queue = useMessageQueueStore.getState().getQueue("chat-a");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      text: "Use 8 seeds",
      agentId: "a",
      backendSessionId: "backend-a",
      userId: "user",
      channel: "console",
      requestContext: context.requestContext,
    });
    expect(queue[0].clientMessageId).toBeTruthy();
    expect(queue[0].attachments).toBeUndefined();
    expect(localStorage.getItem("draft")).toBe(
      "unsubmitted composer text and attachments",
    );
  });
  it("rejects stale sessions, agent switches and unavailable chat", () => {
    for (const changed of [
      { active: false },
      { ready: false },
      { agentId: "b" },
      { currentSessionId: "chat-b" },
    ]) {
      expect(() =>
        enqueuePluginSubmission(input, { ...context, ...changed }),
      ).toThrow("original conversation");
    }
    expect(useMessageQueueStore.getState().getQueue("chat-a")).toHaveLength(0);
  });
  it("reports a full queue without silently losing or duplicating the action", () => {
    for (let i = 0; i < MAX_QUEUE_SIZE; i++)
      enqueuePluginSubmission(input, context);
    expect(() => enqueuePluginSubmission(input, context)).toThrow("Queue full");
    expect(useMessageQueueStore.getState().getQueue("chat-a")).toHaveLength(
      MAX_QUEUE_SIZE,
    );
  });
});

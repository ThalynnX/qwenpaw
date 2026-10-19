import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createSdkSessionAdapter } from "../sdkSessionAdapter";
import {
  ChatSessionTransition,
  ReadyChatWelcome,
} from "./ChatSessionTransition";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("hides the SDK surface and welcome until hydration completes", async () => {
  const session = { id: "target", name: "target", messages: [] };
  const adapter = createSdkSessionAdapter({
    getSession: async () => session,
    getSessionList: async () => [],
    updateSession: async () => [],
    removeSession: async () => [],
    createSession: async () => ({ session, sessions: [session] }),
  });
  render(
    <ChatSessionTransition
      adapter={adapter}
      sessionId="target"
      onRetry={vi.fn()}
    >
      <div>Previous conversation</div>
      <ReadyChatWelcome adapter={adapter} sessionId="target">
        <div>Welcome</div>
      </ReadyChatWelcome>
    </ChatSessionTransition>,
  );
  const surface = screen.getByText("Previous conversation").parentElement!;
  expect(surface.inert).toBe(true);
  expect(surface).not.toBeVisible();
  expect(screen.queryByText("Welcome")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("common.loading");
  await act(async () => {
    await adapter.api.getSession("target");
  });
  expect(surface.inert).toBe(false);
  await waitFor(() => expect(surface).toBeVisible());
  expect(screen.getByText("Welcome")).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
});

it("delegates failed hydration retry without bypassing the SDK loader", async () => {
  const user = userEvent.setup();
  const session = { id: "target", name: "target", messages: [] };
  const getSession = vi.fn().mockRejectedValueOnce(new Error("offline"));
  const onRetry = vi.fn();
  const adapter = createSdkSessionAdapter({
    getSession,
    getSessionList: async () => [],
    updateSession: async () => [],
    removeSession: async () => [],
    createSession: async () => ({ session, sessions: [session] }),
  });
  render(
    <ChatSessionTransition
      adapter={adapter}
      sessionId="target"
      onRetry={onRetry}
    >
      <div>Recovered conversation</div>
    </ChatSessionTransition>,
  );

  await act(async () => {
    await expect(adapter.api.getSession("target")).rejects.toThrow("offline");
  });

  const surface = screen.getByText("Recovered conversation").parentElement!;
  expect(surface.inert).toBe(true);
  expect(surface).not.toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("chat.historyLoadFailed");

  await user.click(screen.getByRole("button", { name: "common.retry" }));

  expect(onRetry).toHaveBeenCalledOnce();
  expect(getSession).toHaveBeenCalledOnce();
  expect(surface.inert).toBe(true);
  expect(surface).not.toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("chat.historyLoadFailed");
});

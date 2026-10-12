import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UserMessageAnchors from "../../../node_modules/@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/Chat/MessageList/UserMessageAnchors";
import { scrollReverseMessageList } from "./messageScroll";

const messages = [
  { id: "message-1", role: "user", cards: [] },
  { id: "message-2", role: "user", cards: [] },
];

function renderAnchors() {
  const onEnsureMessageVisible = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <div className="chat">
      <div className="message-scroll chat-anywhere-message-list-bubble-scroll bubble-list-order-desc">
        <div id="message-1" data-role="message" />
        <div id="message-2" data-role="message" />
      </div>
      <UserMessageAnchors
        enabled
        items={messages as never}
        minCount={2}
        prefixCls="chat"
        renderedItemsKey="messages"
        scrollContainerClassName="message-scroll"
        minGap={0}
        onEnsureMessageVisible={onEnsureMessageVisible}
      />
    </div>,
  );
  const scrollContainer = view.container.querySelector(
    ".message-scroll",
  ) as HTMLElement;
  const root = view.container.querySelector(".chat") as HTMLElement;
  const firstMessage = view.container.querySelector(
    "#message-1",
  ) as HTMLElement;
  const secondMessage = view.container.querySelector(
    "#message-2",
  ) as HTMLElement;

  Object.defineProperties(scrollContainer, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 1200 },
    scrollTop: { configurable: true, writable: true, value: 300 },
  });
  const scrollBy = vi.fn((options: ScrollToOptions) => {
    scrollContainer.scrollTop += Number(options.top ?? 0);
  });
  Object.defineProperty(scrollContainer, "scrollBy", {
    configurable: true,
    value: scrollBy,
  });
  root.addEventListener(
    "wheel",
    (event) => {
      const wheel = event as WheelEvent;
      if (
        scrollReverseMessageList(
          root,
          wheel.target,
          wheel.deltaY,
          wheel.deltaMode,
        )
      ) {
        wheel.preventDefault();
      }
    },
    true,
  );
  vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue({
    top: 100,
    right: 500,
    bottom: 400,
    left: 0,
    width: 500,
    height: 300,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  });
  vi.spyOn(firstMessage, "getBoundingClientRect").mockReturnValue({
    top: 110,
    right: 400,
    bottom: 150,
    left: 0,
    width: 400,
    height: 40,
    x: 0,
    y: 110,
    toJSON: () => ({}),
  });
  vi.spyOn(secondMessage, "getBoundingClientRect").mockReturnValue({
    top: 230,
    right: 400,
    bottom: 270,
    left: 0,
    width: 400,
    height: 40,
    x: 0,
    y: 230,
    toJSON: () => ({}),
  });

  return {
    ...view,
    onEnsureMessageVisible,
    root,
    scrollContainer,
    secondMessage,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(window.performance.now()), 16),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number) => window.clearTimeout(id),
  });
});

describe("UserMessageAnchors scroll cancellation", () => {
  it.each([
    [
      "wheel",
      (element: HTMLElement) => {
        fireEvent.wheel(element, { deltaY: 100, deltaMode: 0 });
      },
    ],
    [
      "touchmove",
      (element: HTMLElement) => {
        fireEvent.touchMove(element);
        element.scrollTop = -200;
      },
    ],
    [
      "pointer drag",
      (element: HTMLElement) => {
        fireEvent.pointerDown(element, { clientX: 300, clientY: 200 });
        element.scrollTop = -200;
      },
    ],
    [
      "scroll key",
      (element: HTMLElement) => {
        fireEvent.keyDown(element, { key: "PageDown" });
        element.scrollTop = -200;
      },
    ],
  ])("cancels settling after %s input", async (_input, dispatchInput) => {
    const { onEnsureMessageVisible, scrollContainer, secondMessage } =
      renderAnchors();
    const scrollBy = vi.mocked(scrollContainer.scrollBy);
    scrollContainer.scrollTop = -300;

    fireEvent.click(document.querySelectorAll(".chat-anchor")[0]);
    expect(onEnsureMessageVisible).toHaveBeenCalledWith("message-2");
    await waitFor(() => expect(scrollBy).toHaveBeenCalledTimes(1));

    act(() => dispatchInput(scrollContainer));
    const userScrollTop = scrollContainer.scrollTop;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1750));
    });

    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollContainer.scrollTop).toBe(userScrollTop);
    expect(secondMessage).not.toHaveClass("chat-anchor-target-active");
  });

  it("settles and highlights when the user does not interrupt", async () => {
    const { scrollContainer, secondMessage } = renderAnchors();
    const scrollBy = vi.mocked(scrollContainer.scrollBy);

    fireEvent.click(document.querySelectorAll(".chat-anchor")[0]);

    await waitFor(
      () => expect(secondMessage).toHaveClass("chat-anchor-target-active"),
      { timeout: 2500 },
    );
    expect(scrollBy.mock.calls.length).toBeGreaterThan(1);
  });
});

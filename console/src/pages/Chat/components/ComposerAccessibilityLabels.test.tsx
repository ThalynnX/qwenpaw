// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ComposerAccessibilityLabels from "./ComposerAccessibilityLabels";

const inputState = vi.hoisted(() => ({ loading: false }));

vi.mock("@agentscope-ai/chat", () => ({
  useChatAnywhereInput: (selector: (value: typeof inputState) => unknown) =>
    selector(inputState),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "chat.composer.send": "Send message",
        "chat.composer.stop": "Stop generating",
      })[key] ?? key,
  }),
}));

function Harness() {
  return (
    <div className="qwenpaw-chat-anywhere-layout">
      <button className="qwenpaw-sender-actions-btn" />
      <ComposerAccessibilityLabels />
    </div>
  );
}

describe("ComposerAccessibilityLabels", () => {
  beforeEach(() => {
    inputState.loading = false;
  });

  it("labels the send and stop actions from the current loading state", () => {
    const view = render(<Harness />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();

    inputState.loading = true;
    view.rerender(<Harness />);
    expect(
      screen.getByRole("button", { name: "Stop generating" }),
    ).toBeTruthy();
  });
});

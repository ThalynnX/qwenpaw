// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
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
        "chat.speech.startRecording": "Start voice recording",
        "chat.speech.stopRecording": "Stop recording",
      })[key] ?? key,
  }),
}));

function Harness({ showMarker = true }: { showMarker?: boolean }) {
  return (
    <div className="shell qwenpaw-chat-anywhere-layout layout-extra">
      <div className="qwenpaw-chat-anywhere-layout-right right-extra">
        <div className="qwenpaw-chat-anywhere-layout-right-header header-extra">
          {showMarker ? <ComposerAccessibilityLabels /> : null}
        </div>
        <div className="qwenpaw-chat-anywhere-chat-sender sender-shell-extra">
          <div className="qwenpaw-sender sender-extra">
            <div className="qwenpaw-sender-prefix prefix-extra">
              <button
                type="button"
                className="qwenpaw-sender-actions-btn spark-button"
              >
                <svg aria-label="spark-mic-line" />
              </button>
            </div>
            <div className="qwenpaw-sender-actions-list actions-extra">
              <button
                type="button"
                className="qwenpaw-sender-actions-btn spark-button"
              >
                <svg aria-label="arrow-up" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

describe("ComposerAccessibilityLabels", () => {
  beforeEach(() => {
    inputState.loading = false;
  });

  it("labels SDK microphone and send actions in the real multi-class layout", () => {
    const view = render(<Harness />);
    expect(
      screen.getByRole("button", { name: "Start voice recording" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();

    inputState.loading = true;
    view.rerender(<Harness />);
    expect(
      screen.getByRole("button", { name: "Start voice recording" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Stop generating" }),
    ).toBeTruthy();
  });

  it("labels replaced SDK actions and disconnects its local observer", async () => {
    const view = render(<Harness />);
    const actions = view.container.querySelector<HTMLElement>(
      ".qwenpaw-sender-actions-list",
    )!;
    actions.innerHTML = `
      <button class="spark-button qwenpaw-sender-actions-btn" type="button">
        <svg aria-label="arrow-up"></svg>
      </button>
    `;

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy(),
    );

    view.rerender(<Harness showMarker={false} />);
    actions.innerHTML = `
      <button class="qwenpaw-sender-actions-btn spark-button" type="button">
        <svg aria-label="arrow-up"></svg>
      </button>
    `;
    await Promise.resolve();
    expect(actions.querySelector("button")).not.toHaveAttribute("aria-label");
  });
});

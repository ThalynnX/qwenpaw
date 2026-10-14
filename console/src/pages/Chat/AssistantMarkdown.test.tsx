import React, { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { chatExtensions } from "../../plugins/registry/chatExtensions";
import type { ChatCodeBlockProps } from "../../plugins/types/qwenpaw";

vi.mock("@agentscope-ai/design", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ConfigProvider: Object.assign(() => null, {
    ConfigContext: React.createContext({
      getPrefixCls: (name: string) => name,
    }),
  }),
}));

vi.mock("../../contexts/FontSizeContext", () => ({
  useEffectiveFontSize: () => 14,
}));
vi.mock("../../plugins/hostSdk/hooks", () => ({
  useHostSelectedAgent: () => ({ id: "agent-a" }),
  useHostCurrentSession: () => ({ id: "session-a" }),
}));
vi.mock("../../components/RenderableCodeBlock/RenderableCodeBlock", () => ({
  RenderableCodeBlock: ({ children }: { children: React.ReactNode }) => (
    <code>{children}</code>
  ),
}));

afterEach(() => {
  cleanup();
  chatExtensions.__resetForTests();
});

describe("assistant code block plugins", () => {
  it("streams original source and preserves local state as later blocks arrive", () => {
    const seen: ChatCodeBlockProps[] = [];
    function UI(props: ChatCodeBlockProps) {
      seen.push(props);
      const [value, setValue] = useState(5);
      return (
        <button disabled={props.isStreaming} onClick={() => setValue(8)}>
          {value}
        </button>
      );
    }
    const registration = chatExtensions.addCodeBlock("test", "openui-lang", UI);
    const start = 'Before\n\n```openui-lang\nroot = TextContent("hello")';
    const view = render(
      <AssistantMarkdown messageId="m1" content={start} cursor />,
    );
    expect(seen[seen.length - 1]?.source).toBe('root = TextContent("hello")\n');
    expect(seen[seen.length - 1]?.isStreaming).toBe(true);
    const blockId = seen[seen.length - 1]?.blockId;
    const closed = start + "\n```\n\nAfter";
    view.rerender(<AssistantMarkdown messageId="m1" content={closed} cursor />);
    expect(seen[seen.length - 1]?.isStreaming).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    expect(screen.getByRole("button", { name: "8" })).toBeEnabled();
    const withSecond =
      closed + '\n\n```openui-lang\nroot = TextContent("second")';
    view.rerender(
      <AssistantMarkdown messageId="m1" content={withSecond} cursor />,
    );
    expect(screen.getByRole("button", { name: "8" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "5" })).toBeDisabled();
    view.rerender(
      <AssistantMarkdown
        messageId="m1"
        content={withSecond + "\n```"}
        cursor={false}
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "8",
      "5",
    ]);
    expect(
      seen
        .slice()
        .reverse()
        .find((p) => p.source.includes("hello"))?.blockId,
    ).toBe(blockId);
    expect(view.container.textContent).toMatch(/Before\s*8\s*After\s*5/);
    act(() => registration.dispose());
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(view.container.querySelectorAll("code")).toHaveLength(2);
  });

  it("renders ordinary and escaped examples as code; restores an earlier registration", () => {
    chatExtensions.addCodeBlock("a", "openui-lang", () => (
      <span>first plugin</span>
    ));
    const second = chatExtensions.addCodeBlock("b", "openui-lang", () => (
      <span>second plugin</span>
    ));
    const content =
      '```js\nalert(1)\n```\n\n````text\n```openui-lang\nroot = TextContent("example")\n```\n````\n\n```openui-lang\nroot = TextContent("live")\n```';
    const view = render(
      <AssistantMarkdown content={content} cursor={false} messageId="m2" />,
    );
    expect(screen.getByText("second plugin")).toBeInTheDocument();
    expect(view.container.querySelectorAll("code")).toHaveLength(2);
    act(() => second.dispose());
    expect(screen.getByText("first plugin")).toBeInTheDocument();
  });

  it("handles a mixed response split at every character boundary", () => {
    const sources: string[] = [];
    chatExtensions.addCodeBlock("test", "openui-lang", (props) => {
      sources.push(props.source);
      return <span data-testid="inline">{props.source}</span>;
    });
    const content =
      'Before\n\n```openui-lang\nroot = TextContent("hello")\n```\n\nAfter';
    const view = render(
      <AssistantMarkdown messageId="chunked" content="" cursor />,
    );
    for (let i = 1; i <= content.length; i++) {
      view.rerender(
        <AssistantMarkdown
          messageId="chunked"
          content={content.slice(0, i)}
          cursor
        />,
      );
    }
    view.rerender(
      <AssistantMarkdown
        messageId="chunked"
        content={content}
        cursor={false}
      />,
    );
    expect(screen.getAllByTestId("inline")).toHaveLength(1);
    expect(sources[sources.length - 1]).toBe('root = TextContent("hello")\n');
    expect(sources.every((source) => !source.includes(":dot:"))).toBe(true);
    expect(view.container.textContent).toMatch(
      /Before[\s\S]*hello[\s\S]*After/,
    );
  });

  it("isolates a throwing plugin to the original code fallback", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    chatExtensions.addCodeBlock("bad", "openui-lang", () => {
      throw new Error("broken");
    });
    const view = render(
      <AssistantMarkdown
        content={"Before\n\n```openui-lang\ninvalid\n```\n\nAfter"}
        cursor={false}
        messageId="m3"
      />,
    );
    expect(view.container.querySelector("code")?.textContent).toContain(
      "invalid",
    );
    expect(view.container.textContent).toContain("After");
    log.mockRestore();
  });
});

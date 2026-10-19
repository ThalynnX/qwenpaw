import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ACPAgentConfig, ACPConfig } from "../../../api/types";

const mocks = vi.hoisted(() => ({
  getACPConfig: vi.fn(),
  updateACPConfig: vi.fn(),
  updateACPAgentConfig: vi.fn(),
  getACPNodeRuntime: vi.fn(),
  updateACPNodeRuntime: vi.fn(),
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../../api", () => ({
  default: {
    getACPConfig: mocks.getACPConfig,
    updateACPConfig: mocks.updateACPConfig,
    updateACPAgentConfig: mocks.updateACPAgentConfig,
    getACPNodeRuntime: mocks.getACPNodeRuntime,
    updateACPNodeRuntime: mocks.updateACPNodeRuntime,
  },
}));

vi.mock("../../../stores/agentStore", () => ({
  useAgentStore: () => ({ selectedAgent: "default" }),
}));

vi.mock("../../../hooks/useAppMessage", () => ({
  useAppMessage: () => ({ message: mocks.message }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@agentscope-ai/design", async () =>
  vi.importActual<typeof import("antd")>("antd"),
);

vi.mock("@/components/PageHeader", () => ({
  PageHeader: ({
    current,
    extra,
  }: {
    current: string;
    extra?: React.ReactNode;
  }) => (
    <header>
      <h1>{current}</h1>
      {extra}
    </header>
  ),
}));

vi.mock("@/components/InlineHelp", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@number-flow/react", () => ({
  default: ({ value }: { value: number }) => <span>{value}</span>,
}));

vi.mock("@/components/interaction/Cascade", () => ({
  Cascade: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/interaction/SharedModal", () => ({
  SharedModal: () => null,
}));

vi.mock("./components/ACPCard", () => ({
  ACPCard: ({
    agentKey,
    onToggle,
  }: {
    agentKey: string;
    onToggle: () => Promise<void>;
  }) => (
    <div>
      <span>{agentKey}</span>
      <button type="button" onClick={() => void onToggle()}>
        toggle-{agentKey}
      </button>
    </div>
  ),
}));

vi.mock("./components/ACPDrawer", () => ({
  ACPDrawer: ({
    open,
    onSubmit,
  }: {
    open: boolean;
    onSubmit: (values: Record<string, unknown>) => Promise<boolean | void>;
  }) =>
    open ? (
      <div role="dialog">
        <button
          type="button"
          onClick={() =>
            void onSubmit({
              agentKey: "new-agent",
              enabled: true,
              command: "new-agent-command",
              argsText: "--serve",
              envText: "TOKEN=value",
              trusted: true,
              tool_parse_mode: "call_title",
            })
          }
        >
          save-new-agent
        </button>
      </div>
    ) : null,
}));

import ACPPage from "./index";

const existingAgent: ACPAgentConfig = {
  enabled: true,
  command: "existing-command",
  args: ["--existing"],
  env: { EXISTING: "value" },
  trusted: true,
  tool_parse_mode: "call_title",
};

const loadedConfig: ACPConfig = {
  node_path: "/custom/node",
  agents: { "existing-custom": existingAgent },
};

describe("ACP load guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getACPConfig
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(loadedConfig);
    mocks.updateACPConfig.mockImplementation(
      async (config: ACPConfig) => config,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks mutations after load failure and retries into complete state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ACPPage />);

    const retry = await screen.findByRole("button", { name: "common.retry" });
    expect(screen.getByRole("alert")).toHaveTextContent("acp.loadError");
    expect(screen.queryByRole("button", { name: "acp.create" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "acp.nodeSettings" }),
    ).toBeNull();
    expect(screen.queryByText("existing-custom")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "toggle-existing-custom" }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.getACPNodeRuntime).not.toHaveBeenCalled();
    expect(mocks.updateACPConfig).not.toHaveBeenCalled();
    expect(mocks.updateACPAgentConfig).not.toHaveBeenCalled();
    expect(mocks.updateACPNodeRuntime).not.toHaveBeenCalled();

    fireEvent.click(retry);

    expect(await screen.findByText("existing-custom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "acp.create" }));
    fireEvent.click(screen.getByRole("button", { name: "save-new-agent" }));

    await waitFor(() => expect(mocks.updateACPConfig).toHaveBeenCalledOnce());
    expect(mocks.updateACPConfig).toHaveBeenCalledWith({
      node_path: "/custom/node",
      agents: {
        "existing-custom": existingAgent,
        "new-agent": expect.objectContaining({
          enabled: true,
          command: "new-agent-command",
        }),
      },
    });
  });
});

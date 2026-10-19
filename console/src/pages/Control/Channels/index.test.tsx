// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/common_setup";

const mocks = vi.hoisted(() => ({
  fetchChannels: vi.fn(),
  getAclAllPending: vi.fn(),
  setChannels: vi.fn(),
  updateChannelConfig: vi.fn(),
  useChannels: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../../api", () => ({
  default: {
    checkChannelConflict: vi.fn(),
    getAclAllPending: (...args: unknown[]) => mocks.getAclAllPending(...args),
    updateChannelConfig: (...args: unknown[]) =>
      mocks.updateChannelConfig(...args),
  },
}));

vi.mock("../../../hooks/useAppMessage", () => ({
  useAppMessage: () => ({ modal: { confirm: vi.fn() } }),
}));

vi.mock("@/components/PageHeader", () => ({
  PageHeader: ({
    center,
    extra,
  }: {
    center?: ReactNode;
    extra?: ReactNode;
  }) => (
    <header>
      {center}
      {extra}
    </header>
  ),
}));

vi.mock("@/components/interaction/Cascade", () => ({
  Cascade: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@agentscope-ai/design", () => ({
  Form: { useForm: () => [{ setFieldsValue: vi.fn() }] },
}));

vi.mock("antd", () => ({
  App: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Badge: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Button: ({ children, icon, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {icon}
      {children}
    </button>
  ),
  Space: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./components", () => ({
  AccessControlDrawer: () => null,
  ChannelAvailableItem: ({
    channelKey,
    onClick,
  }: {
    channelKey: string;
    onClick: () => void;
  }) => <button onClick={onClick}>{`available-${channelKey}`}</button>,
  ChannelCard: ({
    channelKey,
    onClick,
  }: {
    channelKey: string;
    onClick: () => void;
  }) => <button onClick={onClick}>{`channel-${channelKey}`}</button>,
  ChannelDrawer: ({ open }: { open: boolean }) =>
    open ? <div data-testid="channel-drawer" /> : null,
  PendingApprovalsDrawer: () => null,
  getChannelLabel: (key: string) => key,
  useChannels: () => mocks.useChannels(),
}));

import ChannelsPage from "./index";

function channelsState(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-a",
    channels: {},
    orderedKeys: [],
    channelSchemas: {},
    isBuiltin: vi.fn(() => true),
    loading: false,
    error: null,
    ready: true,
    canMutate: vi.fn(() => true),
    fetchChannels: mocks.fetchChannels,
    setChannels: mocks.setChannels,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAclAllPending.mockResolvedValue([]);
  mocks.useChannels.mockReturnValue(channelsState());
});

describe("ChannelsPage load recovery", () => {
  it("blocks channel actions on failure and retries into a legitimate empty state", () => {
    mocks.useChannels.mockReturnValue(
      channelsState({
        error: new Error("offline"),
        ready: false,
        canMutate: vi.fn(() => false),
      }),
    );
    const view = renderWithProviders(<ChannelsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("channels.loadFailed");
    expect(
      screen.queryByRole("button", { name: "channels.goEnableChannels" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "channels.pendingApprovals" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "channels.manageAccessControl" }),
    ).toBeDisabled();
    expect(mocks.updateChannelConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(mocks.fetchChannels).toHaveBeenCalledOnce();

    mocks.useChannels.mockReturnValue(
      channelsState({
        channels: { dingtalk: { enabled: false, isBuiltin: true } },
        orderedKeys: ["dingtalk"],
      }),
    );
    view.rerender(<ChannelsPage />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("channels.noEnabledChannels")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "channels.goEnableChannels" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "available-dingtalk" }));
    expect(screen.getByTestId("channel-drawer")).toBeInTheDocument();
  });

  it("does not render the empty CTA before the initial request succeeds", () => {
    mocks.useChannels.mockReturnValue(
      channelsState({ loading: true, ready: false }),
    );
    renderWithProviders(<ChannelsPage />);

    expect(screen.getByText("channels.loading")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "channels.goEnableChannels" }),
    ).toBeNull();
  });
});

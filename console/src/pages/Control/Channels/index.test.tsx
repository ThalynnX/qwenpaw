// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/common_setup";

const mocks = vi.hoisted(() => {
  const formValues: Record<string, unknown> = {};
  const formReset = vi.fn();
  const formSet = vi.fn();
  const formApi = {
    resetFields: () => {
      for (const key of Object.keys(formValues)) delete formValues[key];
      formReset();
    },
    setFieldsValue: (values: Record<string, unknown>) => {
      Object.assign(formValues, values);
      formSet(values);
    },
  };
  return {
    fetchChannels: vi.fn(),
    getAclAllPending: vi.fn(),
    setChannels: vi.fn(),
    updateChannelConfig: vi.fn(),
    useChannels: vi.fn(),
    formValues,
    formReset,
    formSet,
    formApi,
    channelDrawerProps: null as null | {
      open: boolean;
      onSubmit: (values: Record<string, unknown>) => Promise<void>;
    },
    aclDrawerProps: null as null | {
      open: boolean;
      ownerAgentId: string | null;
      canMutate: (ownerAgentId: string) => boolean;
      onStale: () => void;
    },
    pendingDrawerProps: null as null | {
      open: boolean;
      ownerAgentId: string | null;
      canMutate: (ownerAgentId: string) => boolean;
      onStale: () => void;
    },
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../../api", () => ({
  default: {
    checkChannelConflict: vi.fn(() => Promise.resolve({ conflict: false })),
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
  Form: {
    useForm: () => [mocks.formApi],
  },
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
  AccessControlDrawer: (props: NonNullable<typeof mocks.aclDrawerProps>) => {
    mocks.aclDrawerProps = props;
    return props.open ? <div data-testid="acl-drawer" /> : null;
  },
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
  ChannelDrawer: (props: NonNullable<typeof mocks.channelDrawerProps>) => {
    mocks.channelDrawerProps = props;
    return props.open ? <div data-testid="channel-drawer" /> : null;
  },
  PendingApprovalsDrawer: (
    props: NonNullable<typeof mocks.pendingDrawerProps>,
  ) => {
    mocks.pendingDrawerProps = props;
    return props.open ? <div data-testid="pending-drawer" /> : null;
  },
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
  mocks.aclDrawerProps = null;
  mocks.pendingDrawerProps = null;
  mocks.channelDrawerProps = null;
  for (const key of Object.keys(mocks.formValues)) {
    delete mocks.formValues[key];
  }
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

  it("closes agent-owned drawers on switch and reloads safely for stale callbacks", () => {
    let currentAgent = "agent-a";
    mocks.useChannels.mockReturnValue(
      channelsState({
        agentId: currentAgent,
        canMutate: (ownerAgentId: string) => ownerAgentId === currentAgent,
      }),
    );
    const view = renderWithProviders(<ChannelsPage />);

    fireEvent.click(
      screen.getByRole("button", { name: "channels.manageAccessControl" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "channels.pendingApprovals" }),
    );
    expect(screen.getByTestId("acl-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("pending-drawer")).toBeInTheDocument();
    const staleAcl = mocks.aclDrawerProps!;
    const stalePending = mocks.pendingDrawerProps!;

    currentAgent = "agent-b";
    mocks.useChannels.mockReturnValue(
      channelsState({
        agentId: currentAgent,
        loading: true,
        ready: false,
        canMutate: (ownerAgentId: string) => ownerAgentId === currentAgent,
      }),
    );
    view.rerender(<ChannelsPage />);

    expect(screen.queryByTestId("acl-drawer")).toBeNull();
    expect(screen.queryByTestId("pending-drawer")).toBeNull();
    expect(staleAcl.canMutate(staleAcl.ownerAgentId!)).toBe(false);
    expect(stalePending.canMutate(stalePending.ownerAgentId!)).toBe(false);
    staleAcl.onStale();
    stalePending.onStale();
    expect(mocks.fetchChannels).toHaveBeenCalledTimes(2);

    mocks.useChannels.mockReturnValue(
      channelsState({
        agentId: currentAgent,
        canMutate: (ownerAgentId: string) => ownerAgentId === currentAgent,
      }),
    );
    view.rerender(<ChannelsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "channels.manageAccessControl" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "channels.pendingApprovals" }),
    );
    expect(mocks.aclDrawerProps?.ownerAgentId).toBe("agent-b");
    expect(mocks.pendingDrawerProps?.ownerAgentId).toBe("agent-b");
    expect(screen.getByTestId("acl-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("pending-drawer")).toBeInTheDocument();
  });

  it("replaces channel drafts when switching agents without leaking secrets", async () => {
    let currentAgent = "agent-a";
    mocks.useChannels.mockReturnValue(
      channelsState({
        agentId: currentAgent,
        channels: {
          dingtalk: {
            enabled: true,
            isBuiltin: true,
            client_id: "agent-a-client",
            client_secret: "agent-a-secret",
            app_secret: "agent-a-app-secret",
            bot_token: "agent-a-bot-token",
            password: "agent-a-password",
          },
        },
        orderedKeys: ["dingtalk"],
        canMutate: (ownerAgentId: string) => ownerAgentId === currentAgent,
      }),
    );
    const view = renderWithProviders(<ChannelsPage />);

    fireEvent.click(screen.getByRole("button", { name: "channel-dingtalk" }));
    expect(mocks.formValues).toMatchObject({
      client_secret: "agent-a-secret",
      app_secret: "agent-a-app-secret",
      bot_token: "agent-a-bot-token",
      password: "agent-a-password",
    });

    currentAgent = "agent-b";
    mocks.useChannels.mockReturnValue(
      channelsState({
        agentId: currentAgent,
        loading: true,
        ready: false,
        canMutate: (ownerAgentId: string) => ownerAgentId === currentAgent,
      }),
    );
    view.rerender(<ChannelsPage />);
    expect(mocks.formValues).toEqual({});

    mocks.useChannels.mockReturnValue(
      channelsState({
        agentId: currentAgent,
        channels: {
          dingtalk: {
            enabled: true,
            isBuiltin: true,
            client_id: "agent-b-client",
          },
        },
        orderedKeys: ["dingtalk"],
        canMutate: (ownerAgentId: string) => ownerAgentId === currentAgent,
      }),
    );
    view.rerender(<ChannelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "channel-dingtalk" }));

    expect(mocks.formValues).toMatchObject({ client_id: "agent-b-client" });
    expect(mocks.formValues).not.toHaveProperty("client_secret");
    expect(mocks.formValues).not.toHaveProperty("app_secret");
    expect(mocks.formValues).not.toHaveProperty("bot_token");
    expect(mocks.formValues).not.toHaveProperty("password");

    await mocks.channelDrawerProps?.onSubmit({ ...mocks.formValues });
    expect(mocks.updateChannelConfig).toHaveBeenCalledOnce();
    expect(mocks.updateChannelConfig).toHaveBeenCalledWith(
      "dingtalk",
      expect.not.objectContaining({
        client_secret: expect.anything(),
        app_secret: expect.anything(),
        bot_token: expect.anything(),
        password: expect.anything(),
      }),
      "agent-b",
    );
  });
});

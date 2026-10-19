// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "antd";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  deny: vi.fn(),
  dismiss: vi.fn(),
  getPending: vi.fn(),
  updatePendingRemark: vi.fn(),
  updateUsername: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../../../hooks/useAppMessage", () => ({
  useAppMessage: () => ({
    message: { error: vi.fn(), success: vi.fn() },
  }),
}));

vi.mock("../../../../api/modules/accessControl", () => ({
  accessControlApi: {
    approveAclPending: (...args: unknown[]) => mocks.approve(...args),
    denyAclPending: (...args: unknown[]) => mocks.deny(...args),
    dismissAclPending: (...args: unknown[]) => mocks.dismiss(...args),
    getAclAllPending: (...args: unknown[]) => mocks.getPending(...args),
    updatePendingRemark: (...args: unknown[]) =>
      mocks.updatePendingRemark(...args),
    updateUsername: (...args: unknown[]) => mocks.updateUsername(...args),
  },
}));

vi.mock("@/components/interaction/SettingsDrawer", () => ({
  SettingsDrawer: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) =>
    open ? <section data-testid="pending-drawer">{children}</section> : null,
}));

import { PendingApprovalsDrawer } from "./PendingApprovalsDrawer";

describe("PendingApprovalsDrawer owner guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPending.mockResolvedValue([
      {
        channel: "dingtalk",
        user_id: "user-a",
        username: "Alice",
        remark: "",
        first_message: "hello",
        timestamp: 1,
      },
    ]);
  });

  it("rejects captured approve, deny, and dismiss callbacks after agent switch", async () => {
    let currentAgent = "agent-a";
    const onStale = vi.fn();
    render(
      <App>
        <PendingApprovalsDrawer
          open
          ownerAgentId="agent-a"
          canMutate={(ownerAgentId) => ownerAgentId === currentAgent}
          onStale={onStale}
          onClose={vi.fn()}
        />
      </App>,
    );
    await waitFor(() => expect(mocks.getPending).toHaveBeenCalledOnce());
    await screen.findByText("Alice");

    currentAgent = "agent-b";
    fireEvent.click(screen.getByRole("button", { name: "channels.approve" }));
    fireEvent.click(screen.getByRole("button", { name: "channels.deny" }));
    fireEvent.click(screen.getByRole("button", { name: "channels.dismiss" }));

    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.deny).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(3);
  });
});

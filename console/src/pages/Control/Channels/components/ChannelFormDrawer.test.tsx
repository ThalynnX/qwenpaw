// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FormInstance } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";

const formCapture = vi.hoisted(() => ({
  current: null as FormInstance<Record<string, unknown>> | null,
}));
const mockMessage = vi.hoisted(() => ({
  destroy: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@agentscope-ai/design", async () => {
  const antd = await vi.importActual<typeof import("antd")>("antd");
  const ActualForm = antd.Form;
  const WrappedForm = Object.assign(
    (props: ComponentProps<typeof ActualForm>) =>
      createElement(ActualForm, props),
    ActualForm,
    {
      useForm: () => {
        const result = ActualForm.useForm<Record<string, unknown>>();
        formCapture.current = result[0];
        return result;
      },
    },
  );
  return { ...antd, Form: WrappedForm };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

vi.mock("../../../../stores/agentStore", () => ({
  useAgentStore: Object.assign(
    () => ({
      selectedAgent: "agent-b",
      agents: [{ id: "agent-b", workspace_dir: "/ws" }],
    }),
    { subscribe: () => () => {} },
  ),
}));

vi.mock("../../../../utils/openExternalLink", () => ({
  openExternalLink: vi.fn(),
}));

vi.mock("../../../../hooks/useAppMessage", () => ({
  useAppMessage: () => ({ message: mockMessage }),
}));

vi.mock("./QrcodeAuthBlock", () => ({
  QrcodeAuthBlock: () => null,
}));

import { ChannelFormDrawer } from "./ChannelFormDrawer";

const schema = {
  label: "Custom",
  description: "Custom channel",
  plugin_id: "custom",
  config_fields: [{ name: "label", label: "Label", type: "text" as const }],
};

function drawerProps(initialValues: Record<string, unknown>) {
  return {
    open: true,
    activeKey: "custom",
    activeLabel: "Custom",
    saving: false,
    initialValues,
    isBuiltin: false,
    channelSchema: schema,
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  formCapture.current = null;
  vi.clearAllMocks();
});

describe("ChannelFormDrawer owner isolation", () => {
  it("remounts the real Ant form and excludes stale secrets from autosave", async () => {
    const agentA = drawerProps({
      enabled: true,
      label: "agent-a",
      client_secret: "agent-a-client-secret",
      app_secret: "agent-a-app-secret",
      bot_token: "agent-a-bot-token",
      password: "agent-a-password",
    });
    const view = render(
      <ChannelFormDrawer
        key="agent-a:custom"
        ownerKey="agent-a:custom"
        {...agentA}
      />,
    );

    await waitFor(() => {
      expect(formCapture.current?.getFieldsValue(true)).toMatchObject({
        client_secret: "agent-a-client-secret",
        app_secret: "agent-a-app-secret",
        bot_token: "agent-a-bot-token",
        password: "agent-a-password",
      });
    });

    const agentB = drawerProps({ enabled: true, label: "agent-b" });
    view.rerender(
      <ChannelFormDrawer
        key="agent-b:custom"
        ownerKey="agent-b:custom"
        {...agentB}
      />,
    );

    await waitFor(() => {
      const values = formCapture.current?.getFieldsValue(true);
      expect(values).toMatchObject({ label: "agent-b" });
      expect(values?.client_secret).toBeUndefined();
      expect(values?.app_secret).toBeUndefined();
      expect(values?.bot_token).toBeUndefined();
      expect(values?.password).toBeUndefined();
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Label" }), {
      target: { value: "agent-b-updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));

    await waitFor(() => expect(agentB.onSubmit).toHaveBeenCalledOnce());
    expect(agentB.onSubmit).toHaveBeenCalledWith(
      expect.not.objectContaining({
        client_secret: expect.anything(),
        app_secret: expect.anything(),
        bot_token: expect.anything(),
        password: expect.anything(),
      }),
    );
  });
});

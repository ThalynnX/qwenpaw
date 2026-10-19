import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPClientInfo } from "../../../api/types";

const mocks = vi.hoisted(() => ({
  useMCP: vi.fn(),
  createClient: vi.fn(),
  updateClient: vi.fn(),
  updatePolicy: vi.fn(),
  toggleEnabled: vi.fn(),
  deleteClient: vi.fn(),
  refreshClients: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@agentscope-ai/design", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Empty: ({ description }: { description: React.ReactNode }) => (
    <div>{description}</div>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
  Select: () => null,
}));
vi.mock("./useMCP", () => ({ useMCP: mocks.useMCP }));
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
vi.mock("@/components/interaction/Cascade", () => ({
  Cascade: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/interaction/SharedModal", () => ({
  SharedModal: () => null,
}));
vi.mock("./components", () => ({
  MCPClientCard: ({
    client,
    onToggle,
  }: {
    client: MCPClientInfo;
    onToggle: (client: MCPClientInfo) => void;
  }) => (
    <article>
      <span>{client.name}</span>
      <button type="button" onClick={() => onToggle(client)}>
        toggle {client.name}
      </button>
    </article>
  ),
}));

import MCPPage from ".";

const client: MCPClientInfo = {
  key: "client-1",
  name: "Client One",
  description: "",
  command: "run",
  enabled: true,
  transport: "stdio",
} as MCPClientInfo;

function state(
  overrides: Partial<ReturnType<typeof baseState>> = {},
): ReturnType<typeof baseState> {
  return { ...baseState(), ...overrides };
}

function baseState() {
  return {
    clients: [] as MCPClientInfo[],
    providerServers: [],
    loading: false,
    error: null as string | null,
    ready: true,
    createClient: mocks.createClient,
    updateClient: mocks.updateClient,
    updatePolicy: mocks.updatePolicy,
    toggleEnabled: mocks.toggleEnabled,
    deleteClient: mocks.deleteClient,
    refreshClients: mocks.refreshClients,
  };
}

describe("MCPPage load recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshClients.mockResolvedValue(undefined);
  });

  it.each([
    ["empty", []],
    ["populated", [client]],
  ] as const)(
    "blocks mutations after an initial failure and recovers to %s",
    async (_stateName, clients) => {
      mocks.useMCP.mockReturnValue(
        state({ ready: false, error: "mcp.loadError" }),
      );
      const user = userEvent.setup();
      const view = render(<MCPPage />);

      expect(screen.getByRole("alert")).toHaveTextContent("mcp.loadError");
      expect(screen.queryByRole("button", { name: "mcp.create" })).toBeNull();
      expect(screen.queryByText("mcp.emptyState")).toBeNull();
      expect(mocks.createClient).not.toHaveBeenCalled();
      expect(mocks.updateClient).not.toHaveBeenCalled();
      expect(mocks.toggleEnabled).not.toHaveBeenCalled();
      expect(mocks.deleteClient).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "common.retry" }));
      expect(mocks.refreshClients).toHaveBeenCalledTimes(1);
      expect(mocks.createClient).not.toHaveBeenCalled();
      expect(mocks.updateClient).not.toHaveBeenCalled();
      expect(mocks.toggleEnabled).not.toHaveBeenCalled();
      expect(mocks.deleteClient).not.toHaveBeenCalled();

      mocks.useMCP.mockReturnValue(state({ clients: [...clients] }));
      view.rerender(<MCPPage />);

      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "mcp.create" })).toBeEnabled();
      if (clients.length) {
        expect(screen.getByText("Client One")).toBeVisible();
      } else {
        expect(screen.getByText("mcp.emptyState")).toBeVisible();
      }
    },
  );

  it("keeps stale clients and CRUD available after a refresh failure", async () => {
    mocks.useMCP.mockReturnValue(
      state({ clients: [client], error: "mcp.loadError" }),
    );
    const user = userEvent.setup();
    render(<MCPPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("mcp.loadError");
    expect(screen.getByText("Client One")).toBeVisible();
    expect(screen.getByRole("button", { name: "mcp.create" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "toggle Client One" }));
    expect(mocks.toggleEnabled).toHaveBeenCalledWith(client);
  });
});

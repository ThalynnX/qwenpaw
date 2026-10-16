// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderWithProviders } from "@/test/common_setup";
import type { Session } from "./components";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockUseSessions = vi.hoisted(() => vi.fn());
const mockListChannelTypes = vi.hoisted(() => vi.fn());
const mockForm = vi.hoisted(() => ({
  setFieldsValue: vi.fn(),
  submit: vi.fn(),
}));
const capturedTableProps = vi.hoisted<{
  value: Record<string, unknown> | null;
}>(() => ({ value: null }));
const capturedCardProps = vi.hoisted<{
  values: Array<Record<string, unknown>>;
}>(() => ({ values: [] }));
const capturedFilterBarProps = vi.hoisted<{
  isMobile?: boolean;
}>(() => ({}));
const stylesSource = readFileSync(
  join(process.cwd(), "src/pages/Control/Sessions/index.module.less"),
  "utf8",
);

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<object>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

vi.mock("../../../api", () => ({
  default: { listChannelTypes: mockListChannelTypes },
}));

vi.mock("./useSessions", () => ({
  useSessions: () => mockUseSessions(),
}));

vi.mock("./components", () => ({
  FilterBar: ({
    isMobile,
    filterTitle,
    onTitleChange,
  }: {
    isMobile?: boolean;
    filterTitle: string;
    onTitleChange: (value: string) => void;
  }) => {
    capturedFilterBarProps.isMobile = isMobile;
    return (
      <input
        aria-label="title-filter"
        value={filterTitle}
        onChange={(event) => onTitleChange(event.target.value)}
      />
    );
  },
  SessionDrawer: () => null,
  formatTime: (value: unknown) => String(value ?? ""),
  useSessionColumns: () => [],
}));

vi.mock("@/components/PageHeader", () => ({
  PageHeader: ({
    className,
    extra,
  }: {
    className?: string;
    extra?: ReactNode;
  }) => <header className={className}>{extra}</header>,
}));

vi.mock("../Channels/components", () => ({
  ChannelIcon: () => <span data-testid="channel-icon" />,
}));

vi.mock("@agentscope-ai/design", () => ({
  Button: ({ children, onClick, ...props }: ComponentProps<"button">) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Card: ({ children, ...props }: { children?: ReactNode }) => {
    capturedCardProps.values.push(props);
    return <article data-testid="session-card">{children}</article>;
  },
  Checkbox: ({ checked, onChange, ...props }: ComponentProps<"input">) => (
    <input type="checkbox" checked={checked} onChange={onChange} {...props} />
  ),
  Form: Object.assign(
    ({ children }: { children?: ReactNode }) => <form>{children}</form>,
    { useForm: () => [mockForm] },
  ),
  Modal: { confirm: vi.fn() },
  Table: (props: Record<string, unknown>) => {
    capturedTableProps.value = props;
    return <div data-testid="sessions-table" />;
  },
  Tabs: ({
    items,
    onChange,
  }: {
    items: Array<{ key: string; label: ReactNode }>;
    onChange: (key: string) => void;
  }) => (
    <div role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

import SessionsPage from "./index";

function createSessions(count: number): Session[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    name: index === 25 ? "Chosen session" : `Session ${index}`,
    user_id: `user-${index}`,
    channel: "console",
    created_at: "2026-10-15T00:00:00Z",
  }));
}

function setMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function setViewportWidth(width: number) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === "(max-width: 1024px)" && width <= 1024,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function mockSessions(count: number) {
  const sessions = createSessions(count);
  mockUseSessions.mockReturnValue({
    sessions,
    loading: false,
    updateSession: vi.fn(),
    deleteSession: vi.fn(),
    batchDeleteSessions: vi.fn(),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
    batchArchiveSessions: vi.fn(),
    batchUnarchiveSessions: vi.fn(),
    activeTab: "active",
    setActiveTab: vi.fn(),
    activeCount: sessions.length,
    archivedCount: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedTableProps.value = null;
  capturedCardProps.values = [];
  capturedFilterBarProps.isMobile = undefined;
  mockListChannelTypes.mockResolvedValue(["console"]);
  setMatchMedia(true);
});

afterEach(() => {
  setMatchMedia(false);
});

describe("SessionsPage mobile progressive rendering", () => {
  it("keeps the compact header override stronger than PageHeader defaults", () => {
    const compactStart = stylesSource.indexOf("@media (max-width: 1024px)");
    const compactRules = stylesSource.slice(compactStart);

    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactRules).toContain(".sessionsPage .pageHeader {");
    expect(compactRules).toContain("display: grid;");
    expect(compactRules).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(compactRules).toContain(".tableCard {");
    expect(compactRules).toContain("display: none;");
  });

  it.each([
    { width: 390, compact: true },
    { width: 820, compact: true },
    { width: 1280, compact: false },
  ])(
    "uses the expected responsive layout at $width px",
    async ({ width, compact }) => {
      setViewportWidth(width);
      mockSessions(2);
      renderWithProviders(<SessionsPage />);

      if (compact) {
        await waitFor(() =>
          expect(screen.getAllByTestId("session-card")).toHaveLength(2),
        );
        expect(screen.queryByTestId("sessions-table")).toBeNull();
      } else {
        await waitFor(() =>
          expect(screen.getByTestId("sessions-table")).toBeTruthy(),
        );
        expect(screen.getAllByTestId("session-card")).toHaveLength(1);
      }
      expect(capturedFilterBarProps.isMobile).toBe(compact);
      expect(document.querySelector("header")?.className).toBeTruthy();
      expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 1024px)");
    },
  );

  it.each([500, 2000])(
    "bounds the first mobile render for %i sessions",
    async (count) => {
      mockSessions(count);
      renderWithProviders(<SessionsPage />);

      await waitFor(() => {
        expect(screen.getAllByTestId("session-card")).toHaveLength(20);
      });
      expect(
        screen.getByRole("button", { name: "common.loadMore" }),
      ).toBeTruthy();
    },
  );

  it("keeps selection and actions correct after loading and filtering", async () => {
    mockSessions(500);
    renderWithProviders(<SessionsPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("session-card")).toHaveLength(20);
    });
    fireEvent.click(screen.getByRole("button", { name: "common.loadMore" }));
    expect(screen.getAllByTestId("session-card")).toHaveLength(40);

    const chosenCard = screen
      .getAllByTestId("session-card")
      .find((card) => within(card).queryByText("Chosen session"));
    expect(chosenCard).toBeTruthy();

    fireEvent.click(
      within(chosenCard!).getByRole("checkbox", {
        name: "sessions.selectSession:Chosen session",
      }),
    );
    expect(
      screen.getByRole("button", { name: "sessions.archive.batchAction (1)" }),
    ).toBeTruthy();

    fireEvent.click(
      within(chosenCard!).getByRole("button", { name: "common.view" }),
    );
    expect(mockNavigate).toHaveBeenCalledWith("/chat/session-25");

    fireEvent.change(screen.getByRole("textbox", { name: "title-filter" }), {
      target: { value: "Chosen" },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("session-card")).toHaveLength(1);
    });
    expect(
      screen.getByRole("checkbox", {
        name: "sessions.selectSession:Chosen session",
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "sessions.archive.batchAction (1)" }),
    ).toBeTruthy();
  });

  it("keeps the desktop table page size at ten", async () => {
    setMatchMedia(false);
    mockSessions(500);
    renderWithProviders(<SessionsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("sessions-table")).toBeTruthy(),
    );
    expect(capturedTableProps.value?.pagination).toEqual({
      pageSize: 10,
      showSizeChanger: false,
    });
    expect(capturedCardProps.values).toContainEqual(
      expect.objectContaining({ styles: { body: { padding: 0 } } }),
    );
    expect(capturedCardProps.values[0]).not.toHaveProperty("bodyStyle");

    const rowSelection = capturedTableProps.value?.rowSelection as {
      onChange: (keys: React.Key[]) => void;
      selectedRowKeys: React.Key[];
    };
    act(() => rowSelection.onChange(["session-1"]));

    await waitFor(() => {
      const currentSelection = capturedTableProps.value?.rowSelection as {
        selectedRowKeys: React.Key[];
      };
      expect(currentSelection.selectedRowKeys).toEqual(["session-1"]);
    });
  });
});

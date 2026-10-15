// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import MainLayout from ".";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: "en" },
  }),
}));

vi.mock("../Sidebar", () => ({ default: () => <aside>Sidebar</aside> }));
vi.mock("../AmbientLight", () => ({ default: () => null }));
vi.mock("../Header", () => ({ default: () => <header>Header</header> }));
vi.mock("../../components/ConsolePollService", () => ({
  default: () => null,
}));
vi.mock("../../components/AgentStatusPollingController", () => ({
  AgentStatusPollingController: () => null,
}));
vi.mock("../../stores/useSyncCodingMode", () => ({
  useSyncCodingMode: () => undefined,
}));
vi.mock("../../plugins/registry/hooks", () => ({
  useRoutes: () => [
    {
      id: "core.chat",
      path: "/chat",
      Component: () => <div>Chat route</div>,
    },
  ],
}));
vi.mock("../../plugins/registry/Slot", () => ({ Slot: () => null }));
vi.mock("../../components/PageShell", () => ({
  PageShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./RouteDocumentTitle", () => ({
  RouteDocumentTitle: () => null,
}));

describe("MainLayout accessibility", () => {
  it("moves focus from the skip link to the main content", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <MainLayout />
      </MemoryRouter>,
    );

    await user.tab();
    const skipLink = screen.getByRole("link", { name: "Skip to content" });
    expect(skipLink).toHaveFocus();
    expect(skipLink).toHaveAttribute("href", "#main-content");

    await user.keyboard("{Enter}");
    expect(screen.getByRole("main")).toHaveFocus();
  });
});

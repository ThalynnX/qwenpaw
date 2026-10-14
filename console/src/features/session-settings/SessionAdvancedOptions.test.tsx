import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/common_setup";
import { SessionAdvancedOptions } from "./SessionAdvancedOptions";
import { loadDecisionSettings, saveDecisionSettings } from "./sessionDecision";

vi.mock("./sessionDecision", () => ({
  loadDecisionSettings: vi.fn(),
  saveDecisionSettings: vi.fn(),
}));
const inherited = { configured: true, enabled: true, override: null };
const disabled = { configured: true, enabled: false, override: false };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadDecisionSettings).mockResolvedValue(inherited);
});

async function expand() {
  fireEvent.click(
    screen.getByRole("button", { name: "chat.sessionSettings.advanced" }),
  );
  return screen.findByRole("switch", {
    name: "chat.sessionSettings.decisionEnabled",
  });
}

it("inherits the agent and saves session overrides with just a switch", async () => {
  renderWithProviders(
    <SessionAdvancedOptions agentId="a" sessionId="s" chatId="c" />,
  );
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(loadDecisionSettings).not.toHaveBeenCalled();
  const toggle = await expand();
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).toBeChecked();
  vi.mocked(saveDecisionSettings).mockResolvedValueOnce(disabled);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(saveDecisionSettings).toHaveBeenLastCalledWith(
    "a",
    { sessionId: "s", chatId: "c" },
    false,
  );
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /save/i }),
  ).not.toBeInTheDocument();

  vi.mocked(saveDecisionSettings).mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).not.toBeChecked();
  vi.mocked(saveDecisionSettings).mockResolvedValueOnce({
    ...inherited,
    override: true,
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(saveDecisionSettings).toHaveBeenLastCalledWith(
    "a",
    { sessionId: "s", chatId: "c" },
    true,
  );
  expect(screen.getAllByRole("button")).toHaveLength(1);
});

it("allows enabling the global model while the agent default is off", async () => {
  const defaultOff = { configured: true, enabled: false, override: null };
  vi.mocked(loadDecisionSettings).mockResolvedValue(defaultOff);
  renderWithProviders(
    <SessionAdvancedOptions agentId="a" sessionId="s" chatId="c" />,
  );
  const toggle = await expand();
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).not.toBeChecked();
  vi.mocked(saveDecisionSettings).mockResolvedValueOnce({
    configured: true,
    enabled: true,
    override: true,
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(saveDecisionSettings).toHaveBeenLastCalledWith(
    "a",
    { sessionId: "s", chatId: "c" },
    true,
  );
  vi.mocked(saveDecisionSettings).mockResolvedValueOnce(disabled);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(toggle).toBeEnabled();
});

it("disables the switch without any decision model", async () => {
  vi.mocked(loadDecisionSettings).mockResolvedValue({
    configured: false,
    enabled: false,
    override: true,
  });
  renderWithProviders(
    <SessionAdvancedOptions agentId="a" sessionId="s" chatId="c" />,
  );
  const toggle = await expand();
  await waitFor(() => expect(loadDecisionSettings).toHaveBeenCalled());
  expect(toggle).toBeDisabled();
  expect(toggle).not.toBeChecked();
  expect(screen.getAllByRole("button")).toHaveLength(1);
});

it("reloads inherited settings each time advanced options are opened", async () => {
  renderWithProviders(<SessionAdvancedOptions agentId="a" sessionId="s" />);
  const toggle = await expand();
  await waitFor(() => expect(toggle).toBeChecked());
  fireEvent.click(
    screen.getByRole("button", { name: "chat.sessionSettings.advanced" }),
  );
  vi.mocked(loadDecisionSettings).mockResolvedValue({
    configured: false,
    enabled: false,
    override: null,
  });
  const restored = await expand();
  await waitFor(() => expect(restored).not.toBeChecked());
  expect(restored).toBeDisabled();
});

import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/common_setup";
import { agentsApi } from "@/api/modules/agents";
import type {
  AgentProfileConfig,
  ModelSlotConfig,
  ModelType,
  ProviderInfo,
} from "@/api/types";
import { AgentModelDefaults } from "./AgentModelDefaults";
import type { ThinkingControlSpec } from "@/features/thinking/types";

const store = vi.hoisted(() => ({ selectedAgent: "a", updateAgent: vi.fn() }));
vi.mock("@/stores/agentStore", () => ({
  useAgentStore: (selector: (state: typeof store) => unknown) =>
    selector(store),
}));
vi.mock("@/api/modules/agents", () => ({
  agentsApi: { getAgent: vi.fn(), updateModelSettings: vi.fn() },
}));
vi.mock("../../Chat/ModelSelector/ModelChoice", () => ({
  ModelChoice: ({
    ariaLabel,
    label,
    description,
    modelType = "chat",
    onChange,
    resetOption,
    disabled,
  }: {
    ariaLabel: string;
    label: string;
    description?: string;
    modelType?: ModelType;
    onChange: (slot: ModelSlotConfig) => void;
    disabled?: boolean;
    resetOption?: { label: string; onReset: () => void };
  }) => (
    <>
      <button
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onChange({ provider_id: "mixed", model: modelType })}
      >
        {label}
      </button>
      <span>{description}</span>
      {resetOption && (
        <button
          disabled={disabled}
          aria-label={`${resetOption.label} ${ariaLabel}`}
          onClick={resetOption.onReset}
        >
          {resetOption.label}
        </button>
      )}
    </>
  ),
}));

const chat = { provider_id: "global", model: "Global Chat" };
const decision = { provider_id: "global", model: "Global Decision" };
const props = {
  providers: [],
  activeModels: { active_llm: chat, default_models: { chat, decision } },
};
const profile = (id: string): AgentProfileConfig => ({
  id,
  name: id,
  fallback_policy: { enabled: false, target_scope: "configured" },
});
let saved: AgentProfileConfig;

beforeEach(() => {
  vi.clearAllMocks();
  store.selectedAgent = "a";
  saved = profile("a");
  vi.mocked(agentsApi.getAgent).mockImplementation(async (id) =>
    id === saved.id ? saved : profile(id),
  );
  vi.mocked(agentsApi.updateModelSettings).mockImplementation(
    async (_id, patch) => (saved = { ...saved, ...patch }),
  );
});

async function selectDecision(enabled: boolean) {
  fireEvent.click(
    screen.getByRole("button", {
      name: enabled
        ? "models.defaultDecisionModel"
        : "modelSelector.noFallback models.defaultDecisionModel",
    }),
  );
}

it("selects and clears a decision model without inheriting global or changing chat", async () => {
  const view = renderWithProviders(<AgentModelDefaults {...props} />);
  const choice = await screen.findByRole("button", {
    name: "models.defaultDecisionModel",
  });
  expect(choice).toHaveTextContent("modelSelector.noFallback");
  expect(screen.queryByText("models.useGlobalModel")).not.toBeInTheDocument();
  fireEvent.click(choice);
  await waitFor(() => expect(choice).toHaveTextContent("mixed / decision"));
  expect(agentsApi.updateModelSettings).toHaveBeenLastCalledWith("a", {
    decision_model: { provider_id: "mixed", model: "decision" },
  });
  view.unmount();
  renderWithProviders(<AgentModelDefaults {...props} />);
  expect(
    await screen.findByRole("button", { name: "models.defaultDecisionModel" }),
  ).toHaveTextContent("mixed / decision");
  await selectDecision(false);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "models.defaultDecisionModel" }),
    ).toHaveTextContent("modelSelector.noFallback"),
  );
  expect(agentsApi.updateModelSettings).toHaveBeenLastCalledWith("a", {
    decision_model: null,
  });
  expect(saved.decision_model).toBeNull();
  expect(saved.active_model).toBeUndefined();
});

it("saves primary model changes and resets immediately without a save button", async () => {
  renderWithProviders(<AgentModelDefaults {...props} />);
  const primary = await screen.findByRole("button", { name: "agent.model" });
  expect(
    screen.queryByRole("button", { name: /save/i }),
  ).not.toBeInTheDocument();
  expect(primary).toHaveTextContent("thinkingControl.modelSource.global");
  expect(
    await screen.findByRole("button", { name: "modelSelector.chooseFallback" }),
  ).toHaveTextContent("modelSelector.noFallback");
  fireEvent.click(primary);
  await waitFor(() => expect(primary).toHaveTextContent("chat"));
  await waitFor(() => expect(primary).toBeEnabled());
  expect(agentsApi.updateModelSettings).toHaveBeenCalledWith("a", {
    active_model: { provider_id: "mixed", model: "chat" },
  });
  expect(store.updateAgent).toHaveBeenCalledWith("a", {
    active_model: { provider_id: "mixed", model: "chat" },
  });
  fireEvent.click(primary);
  expect(agentsApi.updateModelSettings).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole("button", { name: "thinkingControl.modelSource.global" }),
  );
  await waitFor(() =>
    expect(agentsApi.updateModelSettings).toHaveBeenLastCalledWith("a", {
      active_model: null,
    }),
  );
  await waitFor(() =>
    expect(primary).toHaveTextContent("thinkingControl.modelSource.global"),
  );
});

it("keeps the original chat settings alongside the decision choice", async () => {
  renderWithProviders(<AgentModelDefaults {...props} />);
  const choice = await screen.findByRole("button", {
    name: "models.defaultDecisionModel",
  });
  expect(choice).toHaveTextContent("modelSelector.noFallback");
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "agent.model" })).toHaveLength(
    1,
  );
  expect(
    screen.getByRole("button", { name: "modelSelector.subagentModel" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "modelSelector.chooseFallback" }),
  ).toBeInTheDocument();
});

it("does not apply a previous agent's late decision save to the newly selected agent", async () => {
  let resolve!: (value: AgentProfileConfig) => void;
  vi.mocked(agentsApi.updateModelSettings).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = renderWithProviders(<AgentModelDefaults {...props} />);
  const toggle = await screen.findByRole("button", {
    name: "models.defaultDecisionModel",
  });
  await selectDecision(true);
  expect(toggle).toBeDisabled();
  expect(screen.getByRole("button", { name: "agent.model" })).toBeDisabled();
  store.selectedAgent = "b";
  view.rerender(<AgentModelDefaults {...props} />);
  const next = await screen.findByRole("button", {
    name: "models.defaultDecisionModel",
  });
  await act(async () => resolve({ ...profile("a"), decision_model: decision }));
  expect(next).toHaveTextContent("modelSelector.noFallback");
  expect(next).toBeEnabled();
  expect(store.updateAgent).not.toHaveBeenCalled();
});

it("keeps the saved decision value after a failure and allows retry", async () => {
  vi.mocked(agentsApi.updateModelSettings).mockRejectedValueOnce(
    new Error("save failed"),
  );
  renderWithProviders(<AgentModelDefaults {...props} />);
  const toggle = await screen.findByRole("button", {
    name: "models.defaultDecisionModel",
  });
  await selectDecision(true);
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(await screen.findByText("save failed")).toBeInTheDocument();
  expect(toggle).toHaveTextContent("modelSelector.noFallback");
  await selectDecision(true);
  await waitFor(() => expect(toggle).toHaveTextContent("mixed / decision"));
  expect(agentsApi.updateModelSettings).toHaveBeenCalledTimes(2);
});

it("restores failed child changes without affecting the decision model", async () => {
  saved.decision_model = decision;
  vi.mocked(agentsApi.updateModelSettings).mockRejectedValueOnce(
    new Error("child save failed"),
  );
  renderWithProviders(<AgentModelDefaults {...props} />);
  const child = await screen.findByRole("button", {
    name: "modelSelector.subagentModel",
  });
  fireEvent.click(child);
  await waitFor(() => expect(child).toBeEnabled());
  expect(child).toHaveTextContent("modelSelector.sameAsPrimary");
  fireEvent.click(child);
  await waitFor(() => expect(child).toHaveTextContent("mixed:chat"));
  expect(saved.decision_model).toEqual(decision);
  expect(
    screen.getByRole("button", { name: "models.defaultDecisionModel" }),
  ).toHaveTextContent("global / Global Decision");
});

it("selects and disables a chat fallback without changing decision settings", async () => {
  let saved: AgentProfileConfig = {
    ...profile("a"),
    fallback_policy: { enabled: false, target_scope: "free_only" },
    decision_model: decision,
  };
  vi.mocked(agentsApi.getAgent).mockImplementation(async () => saved);
  vi.mocked(agentsApi.updateModelSettings).mockImplementation(
    async (_id, patch) => {
      saved = { ...saved, ...patch };
      return saved;
    },
  );
  renderWithProviders(<AgentModelDefaults {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "modelSelector.chooseFallback" }),
  );
  await waitFor(() =>
    expect(saved.fallback_models).toEqual([
      { provider_id: "mixed", model: "chat" },
    ]),
  );
  expect(saved.fallback_policy).toEqual({
    enabled: true,
    target_scope: "free_only",
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "agent.model" })).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "modelSelector.noFallback modelSelector.chooseFallback",
    }),
  );
  expect(
    screen.getByRole("button", { name: "modelSelector.chooseFallback" }),
  ).toHaveTextContent("modelSelector.noFallback");
  await waitFor(() => expect(saved.fallback_models).toEqual([]));
  expect(saved.fallback_policy).toEqual({
    enabled: false,
    target_scope: "free_only",
  });
  expect(saved.decision_model).toEqual(decision);
  expect(
    vi
      .mocked(agentsApi.updateModelSettings)
      .mock.calls.every(([, patch]) => !("decision_model" in patch)),
  ).toBe(true);
});

it.each([
  {
    control: { kind: "effort", efforts: ["low", "high"], supports_off: true },
    expected: { thinking_level: "high" },
  },
  {
    control: {
      kind: "budget",
      efforts: [],
      supports_off: true,
      budget_min: 1024,
      budget_max: 8192,
    },
    expected: { thinking_level: "budget", thinking_budget: 8192 },
  },
])(
  "immediately saves and resets $control.kind thinking settings",
  async ({ control, expected }) => {
    const providers = [
      {
        id: "global",
        name: "Global",
        is_free_tier: true,
        models: [
          {
            id: chat.model,
            name: chat.model,
            supports_agent_thinking: true,
            thinking_control: control as ThinkingControlSpec,
          },
        ],
      },
    ] as ProviderInfo[];
    renderWithProviders(
      <AgentModelDefaults {...props} providers={providers} />,
    );
    const slider = await screen.findByRole("slider", {
      name: "thinkingControl.title",
    });
    fireEvent.keyDown(slider, { key: "End" });
    await waitFor(() =>
      expect(agentsApi.updateModelSettings).toHaveBeenCalledWith("a", expected),
    );
    const reset = screen.getByRole("button", { name: "thinkingControl.reset" });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    await waitFor(() => expect(reset).toBeDisabled());
    expect(agentsApi.updateModelSettings).toHaveBeenLastCalledWith("a", {
      thinking_level: "inherit",
      ...(control.kind === "budget" ? { thinking_budget: null } : {}),
    });
  },
);

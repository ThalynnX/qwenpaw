import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

async function selectModelTab(type: ModelType) {
  fireEvent.click(
    await screen.findByRole("tab", {
      name:
        type === "chat"
          ? "models.defaultChatModel"
          : "models.defaultDecisionModel",
    }),
  );
}

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
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
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

it("saves each setting independently and preserves both tabs through model changes", async () => {
  saved.fallback_policy = { enabled: true, target_scope: "configured" };
  renderWithProviders(<AgentModelDefaults {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "modelSelector.subagentModel" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "modelSelector.subagentModel" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "modelSelector.chooseFallback" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "agent.model" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "agent.model" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "agent.model" })).toBeEnabled(),
  );
  await selectModelTab("decision");
  fireEvent.click(screen.getByRole("button", { name: "agent.model" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "agent.model" })).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "modelSelector.chooseFallback" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "agent.model" })).toBeEnabled(),
  );
  await selectModelTab("chat");
  expect(screen.getByRole("button", { name: "agent.model" })).toHaveTextContent(
    "chat",
  );
  expect(
    screen.getByRole("button", { name: "modelSelector.subagentModel" }),
  ).toHaveTextContent("mixed:chat");
  expect(
    screen.getByRole("button", { name: "modelSelector.chooseFallback" }),
  ).toHaveTextContent("mixed:chat");
  expect(
    screen.queryByRole("button", { name: /save/i, hidden: true }),
  ).not.toBeInTheDocument();
  expect(vi.mocked(agentsApi.updateModelSettings).mock.calls).toEqual([
    ["a", { subagent_model: { provider_id: "mixed", model: "chat" } }],
    ["a", { fallback_models: [{ provider_id: "mixed", model: "chat" }] }],
    ["a", { active_model: { provider_id: "mixed", model: "chat" } }],
    ["a", { decision_model: { provider_id: "mixed", model: "decision" } }],
    [
      "a",
      {
        decision_fallback_models: [{ provider_id: "mixed", model: "decision" }],
      },
    ],
  ]);
  await selectModelTab("decision");
  expect(screen.getByRole("button", { name: "agent.model" })).toHaveTextContent(
    "decision",
  );
  expect(
    screen.getByRole("button", { name: "modelSelector.chooseFallback" }),
  ).toHaveTextContent("mixed:decision");
  expect(agentsApi.updateModelSettings).toHaveBeenCalledTimes(5);
  expect(agentsApi.getAgent).toHaveBeenCalledTimes(1);
});

it("clears an override to follow the current global default, including an unset decision default", async () => {
  vi.mocked(agentsApi.getAgent).mockResolvedValue({
    ...profile("a"),
    decision_model: { provider_id: "mixed", model: "decision" },
  });
  const view = renderWithProviders(<AgentModelDefaults {...props} />);
  await selectModelTab("decision");
  fireEvent.click(
    await screen.findByRole("button", {
      name: "models.followGlobal",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "agent.model" }),
    ).toHaveTextContent("models.followGlobal"),
  );
  await waitFor(() =>
    expect(agentsApi.updateModelSettings).toHaveBeenCalledWith("a", {
      decision_model: null,
    }),
  );
  view.rerender(
    <AgentModelDefaults
      {...props}
      activeModels={{
        active_llm: chat,
        default_models: { chat, decision: null },
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "agent.model" })).toHaveTextContent(
    "models.followGlobal",
  );
});

it("does not apply a previous agent's late save to the newly selected agent", async () => {
  let resolve!: (value: AgentProfileConfig) => void;
  vi.mocked(agentsApi.updateModelSettings).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = renderWithProviders(<AgentModelDefaults {...props} />);
  await selectModelTab("decision");
  fireEvent.click(await screen.findByRole("button", { name: "agent.model" }));
  expect(screen.getByRole("button", { name: "agent.model" })).toBeDisabled();
  await selectModelTab("chat");
  expect(screen.getByRole("button", { name: "agent.model" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "modelSelector.subagentModel" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "modelSelector.chooseFallback" }),
  ).toBeDisabled();
  store.selectedAgent = "b";
  view.rerender(<AgentModelDefaults {...props} />);
  await screen.findByRole("tab", {
    name: "models.defaultChatModel",
    selected: true,
  });
  await selectModelTab("decision");
  await act(async () =>
    resolve({
      ...profile("a"),
      decision_model: { provider_id: "mixed", model: "decision" },
    }),
  );
  expect(screen.getByRole("button", { name: "agent.model" })).toHaveTextContent(
    "models.followGlobal",
  );
  expect(screen.getByRole("button", { name: "agent.model" })).toBeEnabled();
  expect(store.updateAgent).not.toHaveBeenCalled();
});

it("restores failed primary and child changes and lets the user select them again", async () => {
  vi.mocked(agentsApi.updateModelSettings).mockRejectedValueOnce(
    new Error("save failed"),
  );
  renderWithProviders(<AgentModelDefaults {...props} />);
  await selectModelTab("decision");
  fireEvent.click(screen.getByRole("button", { name: "agent.model" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "agent.model" })).toBeEnabled(),
  );
  expect(await screen.findByText("Error: save failed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "agent.model" })).toHaveTextContent(
    "models.followGlobal",
  );
  fireEvent.click(screen.getByRole("button", { name: "agent.model" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "agent.model" }),
    ).toHaveTextContent("decision"),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "agent.model" })).toBeEnabled(),
  );
  await selectModelTab("chat");
  expect(screen.getByRole("button", { name: "agent.model" })).toHaveTextContent(
    "thinkingControl.modelSource.global",
  );
  vi.mocked(agentsApi.updateModelSettings).mockRejectedValueOnce(
    new Error("child save failed"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "modelSelector.subagentModel" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "modelSelector.subagentModel" }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByRole("button", { name: "modelSelector.subagentModel" }),
  ).toHaveTextContent("modelSelector.sameAsPrimary");
  fireEvent.click(
    screen.getByRole("button", { name: "modelSelector.subagentModel" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "modelSelector.subagentModel" }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByRole("button", { name: "modelSelector.subagentModel" }),
  ).toHaveTextContent("mixed:chat");
  expect(vi.mocked(agentsApi.updateModelSettings).mock.calls).toEqual([
    ["a", { decision_model: { provider_id: "mixed", model: "decision" } }],
    ["a", { decision_model: { provider_id: "mixed", model: "decision" } }],
    ["a", { subagent_model: { provider_id: "mixed", model: "chat" } }],
    ["a", { subagent_model: { provider_id: "mixed", model: "chat" } }],
  ]);
  await selectModelTab("decision");
  expect(screen.getByRole("button", { name: "agent.model" })).toHaveTextContent(
    "decision",
  );
});

it("saves and clears decision fallbacks without changing chat fallbacks", async () => {
  let saved = {
    ...profile("a"),
    fallback_models: [{ provider_id: "mixed", model: "chat" }],
    fallback_policy: { enabled: true, target_scope: "free_only" as const },
  } as AgentProfileConfig;
  vi.mocked(agentsApi.getAgent).mockResolvedValue(saved);
  vi.mocked(agentsApi.updateModelSettings).mockImplementation(
    async (_id, patch) => {
      saved = { ...saved, ...patch };
      return saved;
    },
  );
  renderWithProviders(<AgentModelDefaults {...props} />);
  await selectModelTab("decision");
  const decisionSettings = within(
    await screen.findByRole("region", { name: "models.defaultDecisionModel" }),
  );
  fireEvent.click(
    decisionSettings.getByRole("button", {
      name: "modelSelector.chooseFallback",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "agent.model" })).toBeEnabled(),
  );
  expect(agentsApi.updateModelSettings).toHaveBeenLastCalledWith("a", {
    decision_fallback_models: [{ provider_id: "mixed", model: "decision" }],
  });
  expect(saved.fallback_models).toEqual([
    { provider_id: "mixed", model: "chat" },
  ]);
  expect(saved.fallback_policy).toEqual({
    enabled: true,
    target_scope: "free_only",
  });
  fireEvent.click(
    decisionSettings.getByRole("button", {
      name: "modelSelector.noFallback modelSelector.chooseFallback",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "agent.model" })).toBeEnabled(),
  );
  expect(agentsApi.updateModelSettings).toHaveBeenLastCalledWith("a", {
    decision_fallback_models: [],
    decision_fallback_policy: { enabled: false, target_scope: "configured" },
  });
  expect(
    decisionSettings.getByRole("button", {
      name: "modelSelector.chooseFallback",
    }),
  ).toHaveTextContent("modelSelector.noFallback");
  expect(saved.decision_fallback_models).toEqual([]);
  expect(saved.fallback_models).toEqual([
    { provider_id: "mixed", model: "chat" },
  ]);
});

it("selects and disables a chat fallback without changing decision settings", async () => {
  let saved: AgentProfileConfig = {
    ...profile("a"),
    fallback_policy: { enabled: false, target_scope: "free_only" },
    decision_fallback_models: [decision],
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
  expect(saved.decision_fallback_models).toEqual([decision]);
  expect(
    vi
      .mocked(agentsApi.updateModelSettings)
      .mock.calls.every(([, patch]) => !("decision_fallback_models" in patch)),
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

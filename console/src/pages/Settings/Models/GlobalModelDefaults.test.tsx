import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/common_setup";
import { providerApi } from "@/api/modules/provider";
import { GlobalModelDefaults } from "./GlobalModelDefaults";
import type { ModelSlotConfig, ModelType } from "@/api/types";

vi.mock("@/api/modules/provider", () => ({
  providerApi: { setDefaultModel: vi.fn().mockResolvedValue({}) },
}));
vi.mock("../../Chat/ModelSelector/ModelChoice", () => ({
  ModelChoice: ({
    ariaLabel,
    label,
    modelType,
    onChange,
    resetOption,
  }: {
    ariaLabel: string;
    label: string;
    resetOption?: { label: string; onReset: () => void };
    modelType: ModelType;
    onChange: (slot: ModelSlotConfig) => void;
  }) => (
    <>
      <button
        aria-label={ariaLabel}
        onClick={() => onChange({ provider_id: "mixed", model: modelType })}
      >
        {label}
      </button>
      {resetOption && (
        <button onClick={resetOption.onReset}>{resetOption.label}</button>
      )}
    </>
  ),
}));
it("saves and clears the decision default independently of chat", async () => {
  const saved = vi.fn().mockResolvedValue(undefined);
  const chat = { provider_id: "mixed", model: "chat" };
  const decision = { provider_id: "mixed", model: "decision" };
  renderWithProviders(
    <GlobalModelDefaults
      providers={[]}
      activeModels={{
        active_llm: chat,
        default_models: { chat, decision },
      }}
      onSaved={saved}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "models.defaultDecisionModel" }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(providerApi.setDefaultModel).toHaveBeenLastCalledWith(
    "decision",
    decision,
  );
  expect(
    screen.getByRole("button", { name: "models.defaultChatModel" }),
  ).toHaveTextContent("chat");
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.clear",
    }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  expect(providerApi.setDefaultModel).toHaveBeenLastCalledWith(
    "decision",
    null,
  );
});

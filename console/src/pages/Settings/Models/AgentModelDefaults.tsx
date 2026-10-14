import { useTranslation } from "react-i18next";
import { InteractiveCard } from "@/components/interaction/InteractiveCard";
import type { ActiveModelsInfo, ProviderInfo } from "@/api/types";
import { useAgentStore } from "@/stores/agentStore";
import { AgentModelSettings } from "../../Chat/ModelSelector/AgentModelSettings";
import { buildEligibleProviders } from "../../Chat/ModelSelector/modelSelectorModels";
import styles from "./AgentModelDefaults.module.less";

export function AgentModelDefaults({
  providers,
  activeModels,
}: {
  providers: ProviderInfo[];
  activeModels: ActiveModelsInfo | null;
}) {
  const { t } = useTranslation();
  const agentId = useAgentStore((state) => state.selectedAgent);
  return (
    <InteractiveCard
      as="section"
      tilt={0}
      className={styles.section}
      aria-label={t("models.agentDefaults")}
    >
      <AgentModelSettings
        key={agentId}
        agentId={agentId}
        expanded
        surface="settings"
        providers={buildEligibleProviders(providers)}
        decisionProviders={buildEligibleProviders(providers, "decision")}
        activeProviderId={activeModels?.active_llm?.provider_id}
        activeModelId={activeModels?.active_llm?.model}
      />
    </InteractiveCard>
  );
}

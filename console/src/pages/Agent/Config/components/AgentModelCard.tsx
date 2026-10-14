import InlineHelp from "@/components/InlineHelp";
import { AgentModelSettings } from "@/pages/Chat/ModelSelector/AgentModelSettings";
import { ModelChoice } from "@/pages/Chat/ModelSelector/ModelChoice";
import { buildEligibleProviders } from "@/pages/Chat/ModelSelector/modelSelectorModels";
import { agentsApi } from "@/api/modules/agents";
import { providerApi } from "@/api/modules/provider";
import type { ActiveModelsInfo, ProviderInfo } from "@/api/types";
import { useAppMessage } from "@/hooks/useAppMessage";
import { useAgentStore } from "@/stores/agentStore";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import styles from "./AgentModelCard.module.less";

export function AgentModelCard() {
  const { t } = useTranslation();
  const { message } = useAppMessage();
  const agents = useAgentStore((state) => state.agents);
  const selectedAgent = useAgentStore((state) => state.selectedAgent);
  const refreshAgents = useAgentStore((state) => state.refreshAgents);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeModels, setActiveModels] = useState<ActiveModelsInfo | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  const loadModels = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const [nextProviders, nextActiveModels] = await Promise.all([
        providerApi.listProviders(),
        providerApi.getActiveModels({ scope: "global" }),
      ]);
      setProviders(nextProviders);
      setActiveModels(nextActiveModels);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadModels(), refreshAgents()]).catch((error) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  }, [loadModels, refreshAgents, selectedAgent]);

  const agent = agents.find((item) => item.id === selectedAgent);
  const eligibleProviders = useMemo(
    () => buildEligibleProviders(providers),
    [providers],
  );

  if (!selectedAgent || (agent?.backend && agent.backend !== "qwenpaw")) {
    return null;
  }

  async function saveModel(value?: string) {
    if (!agent) return;
    setBusy(true);
    try {
      if (value) {
        await providerApi.setActiveLlm({
          scope: "agent",
          agent_id: agent.id,
          ...JSON.parse(value),
        });
      } else {
        await agentsApi.updateModelSettings(agent.id, { active_model: null });
      }
      await refreshAgents();
    } catch (error) {
      message.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} aria-label={t("models.agentDefaults")}>
      <div className={styles.heading}>
        <span>{t("models.llmTitle")}</span>
        <InlineHelp>{t("models.agentRuntimeHint")}</InlineHelp>
      </div>
      {loadError && <p role="alert">{loadError}</p>}
      {loading || !agent ? (
        <div className={styles.loading} role="status">
          <LoaderCircle className={styles.spin} size={16} />
          <span>{t("common.loading")}</span>
        </div>
      ) : (
        <>
          <div className={styles.choice}>
            <span>{t("models.primaryModel")}</span>
            <div className={styles.choiceControl}>
              <ModelChoice
                value={agent.active_model}
                label={
                  agent.active_model?.model ||
                  t("thinkingControl.modelSource.global")
                }
                disabled={busy}
                onChange={(value) => void saveModel(JSON.stringify(value))}
              />
              <Tooltip title={t("thinkingControl.modelSource.global")}>
                <button
                  type="button"
                  disabled={busy || !agent.active_model}
                  aria-label={t("thinkingControl.modelSource.global")}
                  onClick={() => void saveModel()}
                >
                  <RotateCcw size={16} />
                </button>
              </Tooltip>
            </div>
          </div>
          <AgentModelSettings
            expanded
            autoSave
            surface="settings"
            key={`${agent.id}:${agent.active_model?.provider_id}:${agent.active_model?.model}`}
            agentId={agent.id}
            providers={eligibleProviders}
            activeProviderId={
              agent.active_model?.provider_id ??
              activeModels?.active_llm?.provider_id
            }
            activeModelId={
              agent.active_model?.model ?? activeModels?.active_llm?.model
            }
          />
        </>
      )}
    </section>
  );
}

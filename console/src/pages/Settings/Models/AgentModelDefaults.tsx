import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, Tooltip } from "antd";
import { RotateCcw } from "lucide-react";
import { InteractiveCard } from "@/components/interaction/InteractiveCard";
import { agentsApi } from "@/api/modules/agents";
import type {
  ActiveModelsInfo,
  AgentModelSettingsPatch,
  AgentProfileConfig,
  ProviderInfo,
  ModelSlotConfig,
  ModelType,
} from "@/api/types";
import { useAgentStore } from "@/stores/agentStore";
import { useAppMessage } from "@/hooks/useAppMessage";
import { AgentModelSettings } from "../../Chat/ModelSelector/AgentModelSettings";
import { buildEligibleProviders } from "../../Chat/ModelSelector/modelSelectorModels";
import { ModelChoice } from "../../Chat/ModelSelector/ModelChoice";
import { ModelFallbackSettings } from "../../Chat/ModelSelector/ModelFallbackSettings";
import selectorStyles from "../../Chat/ModelSelector/index.module.less";
import styles from "./AgentModelDefaults.module.less";

type ModelSettings = Required<AgentModelSettingsPatch>;
type Props = {
  providers: ProviderInfo[];
  activeModels: ActiveModelsInfo | null;
};

function modelSettings(config: AgentProfileConfig): ModelSettings {
  return {
    active_model: config.active_model ?? null,
    fallback_models: config.fallback_models ?? [],
    fallback_policy: config.fallback_policy ?? {
      enabled: true,
      target_scope: "configured",
    },
    subagent_model: config.subagent_model ?? null,
    thinking_level: config.thinking_level ?? "inherit",
    thinking_budget: config.thinking_budget ?? null,
    decision_model: config.decision_model ?? null,
    decision_fallback_models: config.decision_fallback_models ?? [],
    decision_fallback_policy: config.decision_fallback_policy ?? {
      enabled: true,
      target_scope: "configured",
    },
  };
}

export function AgentModelDefaults(props: Props) {
  const agentId = useAgentStore((state) => state.selectedAgent);
  return <AgentModelEditor key={agentId} agentId={agentId} {...props} />;
}

function AgentModelChoice({
  modelType = "chat",
  value,
  disabled,
  onChange,
}: {
  modelType?: ModelType;
  value?: ModelSlotConfig | null;
  disabled?: boolean;
  onChange: (value: ModelSlotConfig | null) => void;
}) {
  const { t } = useTranslation();
  const followGlobal = t(
    modelType === "chat"
      ? "thinkingControl.modelSource.global"
      : "models.followGlobal",
  );
  return (
    <div className={styles.choice}>
      <span>{t("agent.model")}</span>
      <ModelChoice
        ariaLabel={t("agent.model")}
        modelType={modelType}
        value={value}
        label={value?.model || followGlobal}
        disabled={disabled}
        onChange={onChange}
      />
      <Tooltip title={followGlobal}>
        <button
          type="button"
          disabled={disabled || !value}
          aria-label={followGlobal}
          onClick={() => onChange(null)}
        >
          <RotateCcw size={16} />
        </button>
      </Tooltip>
    </div>
  );
}

function AgentModelEditor({
  agentId,
  providers,
  activeModels,
}: Props & { agentId: string }) {
  const { t } = useTranslation();
  const { message } = useAppMessage();
  const updateAgent = useAgentStore((state) => state.updateAgent);
  const [config, setConfig] = useState<AgentProfileConfig | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [draftResetToken, setDraftResetToken] = useState(0);
  const [loadRevision, setLoadRevision] = useState(0);
  const mounted = useRef(false);
  const chatProviders = useMemo(
    () => buildEligibleProviders(providers),
    [providers],
  );

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    setError(undefined);
    void agentsApi
      .getAgent(agentId)
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [agentId, loadRevision]);

  if (config?.backend && config.backend !== "qwenpaw") return null;

  const settings = config && modelSettings(config);
  const chatModel =
    config?.active_model ??
    activeModels?.default_models?.chat ??
    activeModels?.active_llm;
  async function save(patch: AgentModelSettingsPatch) {
    if (!settings || saving) return;
    const changes: AgentModelSettingsPatch = Object.fromEntries(
      Object.entries(patch).filter(
        ([key, value]) =>
          JSON.stringify(value) !==
          JSON.stringify(settings[key as keyof ModelSettings]),
      ),
    );
    if (!Object.keys(changes).length) return;
    setSaving(true);
    try {
      const updated = await agentsApi.updateModelSettings(agentId, changes);
      if (!mounted.current) return;
      setConfig(updated);
      if ("active_model" in changes)
        updateAgent(agentId, { active_model: updated.active_model });
    } catch (reason) {
      if (mounted.current) message.error(String(reason));
    } finally {
      if (mounted.current) {
        setDraftResetToken((value) => value + 1);
        setSaving(false);
      }
    }
  }

  return (
    <InteractiveCard
      as="section"
      tilt={0}
      className={`${styles.section} ${selectorStyles.settingsSurface}`}
      aria-label={t("models.agentDefaults")}
    >
      {error ? (
        <div role="alert">
          {error}
          <button
            type="button"
            onClick={() => setLoadRevision((value) => value + 1)}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : !settings ? (
        <p role="status">{t("modelSelector.loadingAgentSettings")}</p>
      ) : (
        <Tabs
          className={styles.modelTabs}
          defaultActiveKey="chat"
          items={[
            {
              key: "chat",
              label: t("models.defaultChatModel"),
              children: (
                <div className={styles.editor}>
                  <AgentModelChoice
                    value={settings.active_model}
                    disabled={saving}
                    onChange={(value) => void save({ active_model: value })}
                  />
                  <AgentModelSettings
                    expanded
                    surface="settings"
                    disabled={saving}
                    initialConfig={settings}
                    draftResetToken={draftResetToken}
                    onDraftChange={(value) => void save(value)}
                    providers={chatProviders}
                    activeProviderId={chatModel?.provider_id}
                    activeModelId={chatModel?.model}
                  />
                </div>
              ),
            },
            {
              key: "decision",
              label: t("models.defaultDecisionModel"),
              children: (
                <div className={styles.editor}>
                  <section
                    className={styles.modelGroup}
                    aria-label={t("models.defaultDecisionModel")}
                  >
                    <AgentModelChoice
                      modelType="decision"
                      value={settings.decision_model}
                      disabled={saving || !activeModels}
                      onChange={(value) => void save({ decision_model: value })}
                    />
                    <ModelFallbackSettings
                      modelType="decision"
                      models={settings.decision_fallback_models}
                      enabled={settings.decision_fallback_policy.enabled}
                      providers={buildEligibleProviders(providers, "decision")}
                      disabled={saving}
                      onChange={(models, enabled) =>
                        void save({
                          decision_fallback_models: models,
                          decision_fallback_policy: {
                            ...settings.decision_fallback_policy,
                            enabled,
                          },
                        })
                      }
                    />
                  </section>
                </div>
              ),
            },
          ]}
        />
      )}
    </InteractiveCard>
  );
}

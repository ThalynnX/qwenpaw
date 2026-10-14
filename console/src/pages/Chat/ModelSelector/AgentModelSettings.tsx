import { ModelChoice } from "./ModelChoice";
import { ModelFallbackSettings } from "./ModelFallbackSettings";
import { ThinkingControl } from "@/features/thinking/ThinkingControl";
import type {
  ThinkingPreference,
  ThinkingControlSpec,
} from "@/features/thinking/types";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Save,
  Settings2,
  RotateCcw,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { agentsApi } from "@/api/modules/agents";
import type {
  AgentModelSettingsPatch,
  AgentProfileConfig,
  ModelInfo,
  ModelSlotConfig,
} from "@/api/types";
import { useAppMessage } from "@/hooks/useAppMessage";
import { useAgentStore } from "@/stores/agentStore";

import styles from "./index.module.less";
import settingsStyles from "../../Settings/Models/AgentModelDefaults.module.less";

interface SettingsProvider {
  id: string;
  name: string;
  models: ModelInfo[];
}

interface AgentModelSettingsProps {
  expanded?: boolean;
  disabled?: boolean;
  agentId?: string;
  providers: SettingsProvider[];
  decisionProviders?: SettingsProvider[];
  activeProviderId?: string;
  activeModelId?: string;
  showThinking?: boolean;
  initialConfig?: Pick<
    AgentProfileConfig,
    | "fallback_models"
    | "fallback_policy"
    | "subagent_model"
    | "thinking_level"
    | "thinking_budget"
  >;
  draftResetToken?: number;
  onDraftChange?: (
    settings: Pick<
      AgentProfileConfig,
      | "fallback_models"
      | "fallback_policy"
      | "subagent_model"
      | "thinking_level"
      | "thinking_budget"
    >,
  ) => void;
  surface?: "default" | "settings";
}

interface ModelOption {
  key: string;
  label: string;
  providerId: string;
  modelId: string;
  supportsThinking: boolean;
  thinkingControl?: ThinkingControlSpec | null;
}

const EMPTY_KEY = "";

function slotKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function supportsThinking(_provider: SettingsProvider, model: ModelInfo) {
  return model.supports_agent_thinking === true;
}

export function AgentModelSettings({
  agentId,
  expanded = false,
  disabled = false,
  providers,
  decisionProviders,
  activeProviderId,
  activeModelId,
  showThinking = true,
  initialConfig,
  draftResetToken,
  onDraftChange,
  surface = "default",
}: AgentModelSettingsProps) {
  const { t } = useTranslation();
  const { message } = useAppMessage();
  const updateAgent = useAgentStore((state) => state.updateAgent);
  const autoSave = surface === "settings" && !!agentId;
  const [open, setOpen] = useState(!agentId);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = disabled || saving;
  const [config, setConfig] = useState<AgentProfileConfig | null>(null);
  const [fallbackEnabled, setFallbackEnabled] = useState(true);
  const [fallbackKeys, setFallbackKeys] = useState<string[]>([]);
  const [subagentKey, setSubagentKey] = useState(EMPTY_KEY);
  const [thinking, setThinking] = useState<ThinkingPreference>({
    level: "inherit",
  });
  const loadRevision = useRef(0);
  const saveRevision = useRef(0);
  const configAgentId = useRef<string | null>(null);
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const bodyId = useId();
  const draftTokenRef = useRef<number | undefined>();

  const options = useMemo<ModelOption[]>(
    () =>
      providers.flatMap((provider) =>
        provider.models.map((model) => ({
          key: slotKey(provider.id, model.id),
          label: `${provider.name} / ${model.name || model.id}`,
          providerId: provider.id,
          modelId: model.id,
          supportsThinking: supportsThinking(provider, model),
          thinkingControl: model.thinking_control,
        })),
      ),
    [providers],
  );
  const optionByKey = useMemo(
    () => new Map(options.map((option) => [option.key, option])),
    [options],
  );
  const slotByKey = useMemo(() => {
    const slots = new Map<string, ModelSlotConfig>();
    options.forEach((option) => {
      slots.set(option.key, {
        provider_id: option.providerId,
        model: option.modelId,
      });
    });
    (config?.fallback_models ?? []).forEach((slot) => {
      slots.set(slotKey(slot.provider_id, slot.model), slot);
    });
    if (config?.subagent_model) {
      slots.set(
        slotKey(config.subagent_model.provider_id, config.subagent_model.model),
        config.subagent_model,
      );
    }
    return slots;
  }, [config, options]);
  const activeOption = optionByKey.get(
    slotKey(
      config?.active_model?.provider_id ?? activeProviderId ?? "",
      config?.active_model?.model ?? activeModelId ?? "",
    ),
  );
  const thinkingSupported = activeOption?.supportsThinking ?? false;
  function applyConfig(next: AgentProfileConfig, targetAgentId: string): void {
    next = {
      fallback_models: [],
      subagent_model: null,
      thinking_level: "inherit",
      thinking_budget: null,
      ...next,
    };
    configAgentId.current = targetAgentId;
    setConfig(next);
    setFallbackEnabled(next.fallback_policy?.enabled ?? true);
    setFallbackKeys(
      (next.fallback_models ?? []).map((slot) =>
        slotKey(slot.provider_id, slot.model),
      ),
    );
    setSubagentKey(
      next.subagent_model
        ? slotKey(next.subagent_model.provider_id, next.subagent_model.model)
        : EMPTY_KEY,
    );
    setThinking({
      level: next.thinking_level ?? "inherit",
      budget_tokens: next.thinking_budget,
    });
  }

  useEffect(() => {
    if (agentId) return;
    if (draftTokenRef.current === draftResetToken && config) return;
    draftTokenRef.current = draftResetToken;
    applyConfig(
      {
        id: "draft",
        name: "",
        ...initialConfig,
      } as AgentProfileConfig,
      "draft",
    );
    setOpen(true);
  }, [agentId, config, draftResetToken, initialConfig]);

  useEffect(() => {
    if (!agentId) return;
    loadRevision.current += 1;
    saveRevision.current += 1;
    configAgentId.current = null;
    setConfig(null);
    setLoadError(null);
    setLoading(false);
    setSaving(false);
    setOpen(false);
    return () => {
      loadRevision.current += 1;
      saveRevision.current += 1;
    };
  }, [agentId]);

  const loadConfig = async (force = false) => {
    if (!agentId) return;
    if ((!force && config) || loading) return;
    const targetAgentId = agentId;
    const revision = ++loadRevision.current;
    setLoadError(null);
    setLoading(true);
    try {
      const next = await agentsApi.getAgent(targetAgentId);
      if (revision !== loadRevision.current || targetAgentId !== agentId) {
        return;
      }
      applyConfig(next, targetAgentId);
    } catch (error) {
      if (revision !== loadRevision.current || targetAgentId !== agentId) {
        return;
      }
      const text =
        error instanceof Error
          ? error.message
          : t("modelSelector.agentSettingsLoadFailed");
      setLoadError(text);
      message.error(text);
    } finally {
      if (revision === loadRevision.current && targetAgentId === agentId) {
        setLoading(false);
      }
    }
  };

  const toggleOpen = async () => {
    const next = !open;
    setOpen(next);
    if (next) await loadConfig(true);
  };

  useEffect(() => {
    if (expanded && agentId) {
      setOpen(true);
      void loadConfig(true);
    }
  }, [expanded, agentId]);
  const pickSlot = (slot: ModelSlotConfig) => {
    const key = slotKey(slot.provider_id, slot.model);
    slotByKey.set(key, slot);
    return key;
  };
  function notifyDraft({
    fallbackEnabled: nextFallbackEnabled = fallbackEnabled,
    fallbackKeys: nextFallbackKeys = fallbackKeys,
    subagentKey: nextSubagentKey = subagentKey,
    thinking: nextThinking = thinking,
  }: {
    fallbackEnabled?: boolean;
    fallbackKeys?: string[];
    subagentKey?: string;
    thinking?: ThinkingPreference;
  } = {}): void {
    if (!config || (agentId && !autoSave)) return;
    const fallbackModels = nextFallbackKeys.flatMap((key) => {
      const slot = slotByKey.get(key);
      return slot ? [slot] : [];
    });
    const settings = {
      fallback_models: fallbackModels,
      fallback_policy: {
        enabled: nextFallbackEnabled,
        target_scope: config.fallback_policy?.target_scope ?? "configured",
      },
      subagent_model: slotByKey.get(nextSubagentKey) ?? null,
      thinking_level: nextThinking.level,
      thinking_budget: nextThinking.budget_tokens ?? null,
    };
    if (autoSave) void save(settings);
    else onDraftChange?.(settings);
  }

  const save = async (patch?: AgentModelSettingsPatch) => {
    if (!agentId || !config || saving || configAgentId.current !== agentId) {
      return;
    }
    if (patch) {
      patch = Object.fromEntries(
        Object.entries(patch).filter(
          ([key, value]) =>
            JSON.stringify(value ?? null) !==
            JSON.stringify(
              config[key as keyof AgentModelSettingsPatch] ?? null,
            ),
        ),
      );
      if (!Object.keys(patch).length) return;
    }
    const targetAgentId = agentId;
    const revision = ++saveRevision.current;
    setSaving(true);
    try {
      const fallbackModels = fallbackKeys.flatMap((key) => {
        const slot = slotByKey.get(key);
        return slot ? [slot] : [];
      });
      const subagentSlot = slotByKey.get(subagentKey);
      const settings = {
        fallback_models: fallbackModels,
        fallback_policy: {
          enabled: fallbackEnabled,
          target_scope: config.fallback_policy?.target_scope ?? "configured",
        },
        subagent_model: subagentSlot ?? null,
        ...(showThinking && thinkingSupported
          ? {
              thinking_level: thinking.level,
              thinking_budget: thinking.budget_tokens ?? null,
            }
          : {}),
      };
      const updated = await agentsApi.updateModelSettings(
        targetAgentId,
        patch ?? settings,
      );
      if (
        revision !== saveRevision.current ||
        targetAgentId !== agentIdRef.current
      ) {
        return;
      }
      applyConfig(updated, targetAgentId);
      if (patch && "active_model" in patch)
        updateAgent(targetAgentId, { active_model: updated.active_model });
      if (!autoSave) message.success(t("modelSelector.agentSettingsSaved"));
    } catch (error) {
      if (
        revision !== saveRevision.current ||
        targetAgentId !== agentIdRef.current
      ) {
        return;
      }
      if (autoSave) applyConfig(config, targetAgentId);
      message.error(
        error instanceof Error
          ? error.message
          : t("modelSelector.agentSettingsSaveFailed"),
      );
    } finally {
      if (revision === saveRevision.current) {
        setSaving(false);
      }
    }
  };

  if (config?.backend && config.backend !== "qwenpaw") return null;
  const decision = config?.decision_model;
  const decisionProvider = decisionProviders?.find(
    (provider) => provider.id === decision?.provider_id,
  );
  const decisionInfo = decisionProvider?.models.find(
    (model) => model.id === decision?.model,
  );
  return (
    <section className={styles.agentModelSettings} data-surface={surface}>
      {!expanded && (
        <button
          type="button"
          className={styles.agentSettingsToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggleOpen}
        >
          <Settings2 size={14} />
          <span>{t("modelSelector.agentModelSettings")}</span>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      )}
      {open && (
        <div id={bodyId} className={styles.agentSettingsBody}>
          {loading ? (
            <div className={styles.settingsStatus} role="status">
              <LoaderCircle size={16} className={styles.spinning} />
              <span>{t("modelSelector.loadingAgentSettings")}</span>
            </div>
          ) : loadError || !config ? (
            <div className={styles.settingsError} role="alert">
              <span>
                {loadError ?? t("modelSelector.agentSettingsLoadFailed")}
              </span>
              <button type="button" onClick={() => void loadConfig()}>
                {t("modelSelector.retry")}
              </button>
            </div>
          ) : (
            <>
              {autoSave && (
                <div className={settingsStyles.choice}>
                  <span>{t("agent.model")}</span>
                  <ModelChoice
                    ariaLabel={t("agent.model")}
                    value={config.active_model}
                    label={
                      config.active_model?.model ||
                      t("thinkingControl.modelSource.global")
                    }
                    disabled={busy}
                    onChange={(active_model) => void save({ active_model })}
                  />
                  <button
                    type="button"
                    title={t("thinkingControl.modelSource.global")}
                    aria-label={t("thinkingControl.modelSource.global")}
                    disabled={busy || !config.active_model}
                    onClick={() => void save({ active_model: null })}
                  >
                    <RotateCcw size={16} />
                  </button>
                </div>
              )}
              {showThinking && (
                <ThinkingControl
                  tone={surface === "settings" ? "quiet" : "default"}
                  control={
                    activeOption?.thinkingControl ?? {
                      kind: "unknown",
                      efforts: [],
                      supports_off: false,
                    }
                  }
                  value={thinking}
                  onChange={(next) => {
                    setThinking(next);
                    notifyDraft({ thinking: next });
                  }}
                  disabled={busy}
                />
              )}
              <div className={styles.settingLine}>
                <span>{t("modelSelector.subagentModel")}</span>
                <ModelChoice
                  ariaLabel={t("modelSelector.subagentModel")}
                  value={slotByKey.get(subagentKey)}
                  label={
                    optionByKey.get(subagentKey)?.label ??
                    (subagentKey || t("modelSelector.sameAsPrimary"))
                  }
                  disabled={busy}
                  onChange={(slot) => {
                    const key = pickSlot(slot);
                    setSubagentKey(key);
                    notifyDraft({ subagentKey: key });
                  }}
                />
                <button
                  type="button"
                  aria-label={t("modelSelector.sameAsPrimary")}
                  disabled={!subagentKey || busy}
                  onClick={() => {
                    setSubagentKey(EMPTY_KEY);
                    notifyDraft({ subagentKey: EMPTY_KEY });
                  }}
                >
                  <RotateCcw size={15} />
                </button>
              </div>
              <ModelFallbackSettings
                models={fallbackKeys.flatMap((key) => {
                  const slot = slotByKey.get(key);
                  return slot ? [slot] : [];
                })}
                enabled={fallbackEnabled}
                providers={providers}
                disabled={busy}
                onChange={(models, enabled) => {
                  const keys = models.map(pickSlot);
                  setFallbackKeys(keys);
                  setFallbackEnabled(enabled);
                  notifyDraft({ fallbackKeys: keys, fallbackEnabled: enabled });
                }}
              />
              {decisionProviders && (
                <div className={styles.settingLine}>
                  <span>{t("models.defaultDecisionModel")}</span>
                  <ModelChoice
                    ariaLabel={t("models.defaultDecisionModel")}
                    modelType="decision"
                    value={decision}
                    label={
                      decision
                        ? `${
                            decisionProvider?.name ?? decision.provider_id
                          } / ${decisionInfo?.name ?? decision.model}`
                        : t("modelSelector.noFallback")
                    }
                    disabled={busy}
                    resetOption={{
                      label: t("modelSelector.noFallback"),
                      onReset: () => void save({ decision_model: null }),
                    }}
                    onChange={(decision_model) => void save({ decision_model })}
                  />
                </div>
              )}
              {agentId && !autoSave && (
                <button
                  type="button"
                  className={styles.saveAgentSettings}
                  aria-label={t(
                    showThinking
                      ? "common.save"
                      : "modelSelector.saveAgentSettings",
                  )}
                  disabled={busy}
                  onClick={() => void save()}
                >
                  {saving ? (
                    <LoaderCircle size={14} className={styles.spinning} />
                  ) : (
                    <Save size={14} />
                  )}
                  {t(
                    showThinking
                      ? "common.save"
                      : "modelSelector.saveAgentSettings",
                  )}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

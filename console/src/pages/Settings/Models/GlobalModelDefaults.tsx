import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelChoice } from "../../Chat/ModelSelector/ModelChoice";
import { providerApi } from "@/api/modules/provider";
import type {
  ActiveModelsInfo,
  ModelSlotConfig,
  ModelType,
  ProviderInfo,
} from "@/api/types";
import { useAppMessage } from "@/hooks/useAppMessage";
import styles from "./index.module.less";

export function GlobalModelDefaults({
  activeModels,
  providers,
  onSaved,
}: {
  activeModels: ActiveModelsInfo | null;
  providers: ProviderInfo[];
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { message } = useAppMessage();
  const [saving, setSaving] = useState(false);
  const save = async (type: ModelType, slot: ModelSlotConfig | null) => {
    setSaving(true);
    try {
      await providerApi.setDefaultModel(type, slot);
      await onSaved();
    } catch (error) {
      message.error(String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className={styles.globalDefaults}
      aria-label={t("models.defaultModels")}
    >
      <span>{t("models.defaultModels")}</span>
      {(["chat", "decision"] as const).map((type) => {
        const slot =
          activeModels?.default_models?.[type] ??
          (type === "chat" ? activeModels?.active_llm : null);
        const provider = providers.find(
          (item) => item.id === slot?.provider_id,
        );
        const model = [
          ...(provider?.models ?? []),
          ...(provider?.extra_models ?? []),
        ].find((item) => item.id === slot?.model);
        const label = t(
          type === "chat"
            ? "models.defaultChatModel"
            : "models.defaultDecisionModel",
        );
        return (
          <div className={styles.defaultModelRow} key={type}>
            <span>{label}</span>
            <ModelChoice
              ariaLabel={label}
              modelType={type}
              value={slot}
              label={model?.name || slot?.model || t("models.noDefaultModel")}
              description={
                provider?.name ||
                slot?.provider_id ||
                t("models.noDefaultModel")
              }
              disabled={saving || !activeModels}
              onChange={(value) => void save(type, value)}
              resetOption={
                type === "decision" && slot
                  ? {
                      label: t("common.clear"),
                      onReset: () => void save(type, null),
                    }
                  : undefined
              }
            />
          </div>
        );
      })}
    </div>
  );
}

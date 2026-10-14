import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelDefaultRow } from "./ModelDefaultRow";
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
        return (
          <ModelDefaultRow
            key={type}
            modelType={type}
            value={slot}
            providers={providers}
            disabled={saving || !activeModels}
            onChange={(value) => void save(type, value)}
          />
        );
      })}
    </div>
  );
}

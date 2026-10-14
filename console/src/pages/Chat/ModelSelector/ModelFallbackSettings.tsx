import { useTranslation } from "react-i18next";
import type { ModelSlotConfig, ProviderInfo } from "@/api/types";
import { ModelChoice } from "./ModelChoice";
import styles from "./index.module.less";

export function ModelFallbackSettings({
  models,
  enabled,
  providers,
  disabled,
  onChange,
}: {
  models: ModelSlotConfig[];
  enabled: boolean;
  providers: Pick<ProviderInfo, "id" | "name" | "models">[];
  disabled?: boolean;
  onChange: (models: ModelSlotConfig[], enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const selected = enabled ? models : [];
  return (
    <>
      {(selected.length ? selected : [null]).map((slot, index) => {
        const provider = providers.find(
          (item) => item.id === slot?.provider_id,
        );
        const model = provider?.models.find((item) => item.id === slot?.model);
        return (
          <div className={styles.settingLine} key={index}>
            <span>{t("modelSelector.chooseFallback")}</span>
            <ModelChoice
              ariaLabel={t("modelSelector.chooseFallback")}
              value={slot}
              label={
                slot
                  ? provider && model
                    ? provider.name + " / " + (model.name || model.id)
                    : slot.provider_id + ":" + slot.model
                  : t("modelSelector.noFallback")
              }
              disabled={disabled}
              resetOption={{
                label: t(
                  selected.length > 1
                    ? "modelSelector.removeFallback"
                    : "modelSelector.noFallback",
                ),
                onReset: () => {
                  const next = selected.filter((_, i) => i !== index);
                  onChange(next, next.length > 0);
                },
              }}
              onChange={(next) => {
                const updated = [...selected];
                updated[index] = next;
                onChange(updated, true);
              }}
            />
          </div>
        );
      })}
    </>
  );
}

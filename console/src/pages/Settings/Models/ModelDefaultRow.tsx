import { useTranslation } from "react-i18next";
import type { ModelSlotConfig, ModelType, ProviderInfo } from "@/api/types";
import { ModelChoice } from "../../Chat/ModelSelector/ModelChoice";
import styles from "./ModelDefaultRow.module.less";

export function ModelDefaultRow({
  modelType,
  value,
  inheritedValue,
  providers,
  disabled,
  onChange,
}: {
  modelType: ModelType;
  value?: ModelSlotConfig | null;
  inheritedValue?: ModelSlotConfig | null;
  providers: ProviderInfo[];
  disabled?: boolean;
  onChange: (value: ModelSlotConfig | null) => void;
}) {
  const { t } = useTranslation();
  const isAgent = inheritedValue !== undefined;
  const effective = value ?? inheritedValue;
  const provider = providers.find((item) => item.id === effective?.provider_id);
  const model = [
    ...(provider?.models ?? []),
    ...(provider?.extra_models ?? []),
  ].find((item) => item.id === effective?.model);
  const label = t(
    modelType === "chat"
      ? "models.defaultChatModel"
      : "models.defaultDecisionModel",
  );
  const source = isAgent
    ? t(value ? "models.agentOverride" : "models.followGlobal")
    : null;
  return (
    <div className={styles.row}>
      <span>{label}</span>
      <ModelChoice
        ariaLabel={label}
        modelType={modelType}
        value={effective}
        label={model?.name || effective?.model || t("models.noDefaultModel")}
        description={
          [provider?.name || effective?.provider_id, source]
            .filter(Boolean)
            .join(" · ") || t("models.noDefaultModel")
        }
        disabled={disabled}
        onChange={onChange}
        resetOption={
          isAgent || (modelType === "decision" && value)
            ? {
                label: t(isAgent ? "models.followGlobal" : "common.clear"),
                onReset: () => onChange(null),
              }
            : undefined
        }
      />
    </div>
  );
}

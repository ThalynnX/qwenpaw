import { ModelPickerPopover } from "./ModelPickerPopover";
import { ProviderIcon } from "../../Settings/Models/components/ProviderIconComponent";
import { lazy, Suspense, useState } from "react";
import { Spin } from "antd";
import { ChevronRight } from "lucide-react";
import type { ModelSlotConfig, ModelType } from "@/api/types";
import styles from "./index.module.less";
const ModelSelector = lazy(() => import("./index"));
export function ModelChoice({
  value,
  modelType = "chat",
  ariaLabel,
  label,
  description,
  resetOption,
  onChange,
  disabled,
  open: controlledOpen,
  onOpenChange,
}: {
  modelType?: ModelType;
  ariaLabel?: string;
  value?: ModelSlotConfig | null;
  label: string;
  description?: string;
  resetOption?: { label: string; onReset: () => void };
  onChange: (value: ModelSlotConfig) => void;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  return (
    <ModelPickerPopover
      open={open}
      onOpenChange={(next) => !disabled && setOpen(next)}
      content={
        <>
          {open && resetOption && (
            <button
              type="button"
              className={styles.modelChoiceReset}
              onClick={() => {
                resetOption.onReset();
                setOpen(false);
              }}
            >
              {resetOption.label}
            </button>
          )}
          {open && (
            <Suspense fallback={<Spin />}>
              <ModelSelector
                embedded
                modelType={modelType}
                selectedSlot={value}
                onPick={(provider_id, model) => {
                  onChange({ provider_id, model });
                  setOpen(false);
                }}
              />
            </Suspense>
          )}
        </>
      }
    >
      <button
        aria-label={ariaLabel}
        type="button"
        className={`${styles.modelChoiceButton} ${
          description ? styles.modelChoiceDetailed : ""
        }`}
        disabled={disabled}
        aria-expanded={open}
      >
        {value && <ProviderIcon providerId={value.provider_id} size={16} />}
        <span className={description ? styles.modelChoiceText : undefined}>
          <span title={label}>{label}</span>
          {description && <small>{description}</small>}
        </span>
        <ChevronRight size={15} />
      </button>
    </ModelPickerPopover>
  );
}

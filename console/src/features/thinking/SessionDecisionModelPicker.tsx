import { useEffect, useRef, useState } from "react";
import { Spin, Tooltip } from "antd";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppMessage } from "@/hooks/useAppMessage";
import ModelSelector from "../../pages/Chat/ModelSelector";
import {
  loadSessionDecisionModel,
  saveSessionDecisionModel,
  type SessionModel,
  type SessionModelScope,
  type SessionModelView,
} from "../session-settings/sessionModel";
import styles from "./thinking.module.less";

export function SessionDecisionModelPicker({
  agentId,
  sessionId,
  chatId,
  onSelected,
}: SessionModelScope & {
  agentId: string;
  onSelected: () => void;
}) {
  const { t } = useTranslation();
  const { message } = useAppMessage();
  const [view, setView] = useState<SessionModelView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const saving = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void loadSessionDecisionModel(agentId, { sessionId, chatId })
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [agentId, sessionId, chatId]);

  async function select(model: SessionModel | null) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await saveSessionDecisionModel(agentId, { sessionId, chatId }, model);
      if (mounted.current) onSelected();
    } catch (error) {
      if (mounted.current) message.error(String(error));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (error)
    return (
      <div role="alert" className={styles.sessionHint}>
        {error}
      </div>
    );
  if (!view) return <Spin />;
  return (
    <fieldset
      className={`${styles.picker} ${styles.decisionPicker}`}
      disabled={busy}
      aria-busy={busy}
    >
      <div className={styles.back}>
        <Tooltip title={t("thinkingControl.resetModel")}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("thinkingControl.resetModel")}
            disabled={busy || view.model_source !== "session"}
            onClick={() => void select(null)}
          >
            <RotateCcw size={15} />
          </button>
        </Tooltip>
      </div>
      <ModelSelector
        embedded
        modelType="decision"
        selectedSlot={
          view.provider_id && view.model
            ? { provider_id: view.provider_id, model: view.model }
            : null
        }
        onPick={(provider_id, model) => void select({ provider_id, model })}
      />
    </fieldset>
  );
}

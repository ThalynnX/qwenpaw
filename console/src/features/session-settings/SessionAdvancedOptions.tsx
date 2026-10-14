import { useEffect, useId, useRef, useState } from "react";
import { Switch } from "antd";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppMessage } from "@/hooks/useAppMessage";
import type { SessionModelScope } from "./sessionModel";
import {
  loadDecisionSettings,
  saveDecisionSettings,
  type DecisionSettings,
} from "./sessionDecision";
import styles from "./SessionAdvancedOptions.module.less";

export function SessionAdvancedOptions({
  agentId,
  sessionId,
  chatId,
}: SessionModelScope & { agentId: string }) {
  const { t } = useTranslation();
  const { message } = useAppMessage();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<DecisionSettings>();
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const id = useId();

  useEffect(() => {
    return () => {
      ++revision.current;
    };
  }, []);

  async function update(enabled?: boolean) {
    if (busy) return;
    const version = ++revision.current;
    setBusy(true);
    try {
      const scope = { sessionId, chatId };
      const next = await (enabled === undefined
        ? loadDecisionSettings(agentId, scope)
        : saveDecisionSettings(agentId, scope, enabled));
      if (version === revision.current) setSettings(next);
    } catch (error) {
      if (version === revision.current) message.error(String(error));
    } finally {
      if (version === revision.current) setBusy(false);
    }
  }

  return (
    <section className={styles.advanced}>
      <button
        type="button"
        className={styles.disclosure}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
          if (!open) void update();
        }}
      >
        {t("chat.sessionSettings.advanced")}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div id={id} hidden={!open}>
        {open && (
          <div className={styles.option}>
            <label htmlFor={`${id}-toggle`}>
              {t("chat.sessionSettings.decisionEnabled")}
            </label>
            <Switch
              id={`${id}-toggle`}
              size="small"
              aria-label={t("chat.sessionSettings.decisionEnabled")}
              checked={settings?.enabled ?? false}
              disabled={!settings?.configured || busy}
              loading={busy}
              onChange={(enabled) => void update(enabled)}
            />
          </div>
        )}
      </div>
    </section>
  );
}

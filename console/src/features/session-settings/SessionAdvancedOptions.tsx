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
  const mounted = useRef(false);
  const revision = useRef(0);
  const id = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function load() {
    const version = ++revision.current;
    setBusy(true);
    try {
      const next = await loadDecisionSettings(agentId, { sessionId, chatId });
      if (mounted.current && version === revision.current) setSettings(next);
    } catch (error) {
      if (mounted.current) message.error(String(error));
    } finally {
      if (mounted.current && version === revision.current) setBusy(false);
    }
  }

  async function save(enabled: boolean) {
    if (busy || !settings) return;
    ++revision.current;
    setBusy(true);
    try {
      const next = await saveDecisionSettings(
        agentId,
        { sessionId, chatId },
        enabled,
      );
      if (mounted.current) setSettings(next);
    } catch (error) {
      if (mounted.current) message.error(String(error));
    } finally {
      if (mounted.current) setBusy(false);
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
          if (!open && !busy) void load();
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
              onChange={(enabled) => void save(enabled)}
            />
          </div>
        )}
      </div>
    </section>
  );
}

import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChatAnywhereInput } from "@agentscope-ai/chat";

const CHAT_LAYOUT_SELECTOR = '[class$="-chat-anywhere-layout"]';
const SENDER_ACTION_SELECTOR = '[class$="-sender-actions-btn"]';

export default function ComposerAccessibilityLabels() {
  const { t } = useTranslation();
  const markerRef = useRef<HTMLSpanElement>(null);
  const loading = useChatAnywhereInput((value) => value.loading);

  useLayoutEffect(() => {
    const layout = markerRef.current?.closest(CHAT_LAYOUT_SELECTOR);
    const action = layout?.querySelector<HTMLButtonElement>(
      SENDER_ACTION_SELECTOR,
    );
    action?.setAttribute(
      "aria-label",
      loading ? t("chat.composer.stop") : t("chat.composer.send"),
    );
  }, [loading, t]);

  return <span ref={markerRef} hidden />;
}

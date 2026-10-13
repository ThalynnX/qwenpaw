import { Code2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BuiltinCardProps } from "./index";
import { DefaultBlock, MediaPreview, ToolCardShell } from "../shared";
import { getMediaInfo, stringifyResult } from "../shared/utils";

export default function CodeModeCard({
  content,
  isStreaming,
}: BuiltinCardProps) {
  const { t } = useTranslation();
  const code =
    typeof content.params.code === "string" ? content.params.code : "";
  const output = stringifyResult(content.result);
  const media = getMediaInfo(content);

  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<Code2 size={16} strokeWidth={1.75} />}
      title={t("codingMode.runCode")}
      defaultExpanded={content.status === "error" || Boolean(media)}
    >
      {code && (
        <DefaultBlock
          title={t("codingMode.script")}
          content={code}
          language="python"
        />
      )}
      {output && (
        <DefaultBlock title={t("codingMode.output")} content={output} />
      )}
      {media && <MediaPreview media={media} />}
    </ToolCardShell>
  );
}

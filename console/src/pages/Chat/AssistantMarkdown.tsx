import React, {
  createContext,
  useContext,
  useDeferredValue,
  useId,
  useRef,
} from "react";
import { Markdown } from "@agentscope-ai/chat";
import { useEffectiveFontSize } from "../../contexts/FontSizeContext";
import { renderableCodeComponents } from "../../components/RenderableCodeBlock";
import { RenderableCodeBlock } from "../../components/RenderableCodeBlock/RenderableCodeBlock";
import { useChatListSnapshot } from "../../plugins/registry/useChatExtensions";
import { PluginSlotBoundary } from "../../plugins/registry/PluginSlotBoundary";
import {
  useHostCurrentSession,
  useHostSelectedAgent,
} from "../../plugins/hostSdk/hooks";
import type { ChatListSnapshot } from "../../plugins/registry/chatExtensions";

interface BlockContext {
  entries: ChatListSnapshot["response.codeBlocks"];
  streaming: boolean;
  messageId: string;
  agentId: string;
  sessionId: string;
}
const CodeBlockContext = createContext<BlockContext | null>(null);

function AssistantCodeBlock(
  props: React.ComponentProps<typeof RenderableCodeBlock>,
) {
  const ctx = useContext(CodeBlockContext);
  const id = useId();
  const language =
    props.lang || props.className?.match(/language-([^\s]+)/)?.[1] || "";
  const entry =
    props.block === true
      ? ctx?.entries
          .slice()
          .reverse()
          .find((e) => e.item.language === language)
      : undefined;
  const fallback = () => <RenderableCodeBlock {...props} />;
  if (!entry || !ctx || typeof props.children !== "string") return fallback();
  const Component = entry.item.render;
  return (
    <PluginSlotBoundary
      key={entry.registrationId}
      slot="response.codeBlocks"
      pluginId={entry.pluginId}
      fallback={fallback()}
    >
      <Component
        source={props.children}
        language={language}
        isStreaming={ctx.streaming && props.streamStatus !== "done"}
        messageId={ctx.messageId}
        blockId={`${ctx.messageId}:${id}`}
        agentId={ctx.agentId}
        sessionId={ctx.sessionId}
        fallback={fallback}
      />
    </PluginSlotBoundary>
  );
}

// A module-level component keeps React identity stable across every stream delta.
const assistantCodeComponents = { code: AssistantCodeBlock };

export function AssistantMarkdown({
  content,
  cursor,
  messageId,
}: {
  content: string;
  cursor: boolean;
  messageId: string;
}) {
  const deferredContent = useDeferredValue(content);
  const baseFontSize = useEffectiveFontSize();
  const entries = useChatListSnapshot()["response.codeBlocks"];
  const agent = useHostSelectedAgent();
  const session = useHostCurrentSession();
  const scope = useRef({ agentId: agent.id, sessionId: session?.id || "" });
  // The SDK may allocate the session after the first render of a new response.
  if (
    !scope.current.sessionId &&
    agent.id === scope.current.agentId &&
    session?.id
  ) {
    scope.current.sessionId = session.id;
  }
  const extended = entries.length > 0;
  return (
    <CodeBlockContext.Provider
      value={{
        entries,
        // Do not finalize an unfinished block against the previous deferred
        // source when the last delta and cursor=false arrive together.
        streaming: cursor || deferredContent !== content,
        messageId,
        ...scope.current,
      }}
    >
      <Markdown
        baseFontSize={baseFontSize}
        components={
          extended ? assistantCodeComponents : renderableCodeComponents
        }
        content={deferredContent}
        // The vendor cursor appends a literal token, which corrupts unfinished DSL.
        cursor={extended ? false : cursor}
      />
      {extended && cursor && (
        <span aria-label="Generating" aria-live="off">
          ▍
        </span>
      )}
    </CodeBlockContext.Provider>
  );
}

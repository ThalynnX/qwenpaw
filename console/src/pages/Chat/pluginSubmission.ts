import type { ChatSubmitInput } from "../../plugins/types/qwenpaw";
import {
  MAX_QUEUE_SIZE,
  useMessageQueueStore,
} from "../../stores/messageQueueStore";
import {
  buildSubmissionBizParams,
  type SubmissionIdentity,
} from "./submissionBizParams";

interface AdmissionContext {
  active: boolean;
  ready: boolean;
  agentId: string;
  currentSessionId: string;
  queueKey: string;
  resolveIdentity: (id: string) => SubmissionIdentity;
  prepareQuery: (query: string) => string;
  requestContext: Record<string, unknown>;
  queueFullMessage: string;
}

/** Synchronous admission captures routing before any queue worker awaits. */
export function enqueuePluginSubmission(
  input: ChatSubmitInput,
  context: AdmissionContext,
): void {
  const identity = context.resolveIdentity(context.currentSessionId);
  const requested = context.resolveIdentity(input.sessionId);
  if (
    !context.active ||
    !context.ready ||
    input.agentId !== context.agentId ||
    !identity.sessionId ||
    requested.sessionId !== identity.sessionId
  ) {
    throw new Error(
      "Open the original conversation before submitting this action.",
    );
  }
  const store = useMessageQueueStore.getState();
  if (store.getQueue(context.queueKey).length >= MAX_QUEUE_SIZE) {
    throw new Error(context.queueFullMessage);
  }
  store.enqueue(context.queueKey, {
    text: context.prepareQuery(input.query),
    agentId: input.agentId,
    backendSessionId: identity.sessionId,
    userId: identity.userId,
    channel: identity.channel,
    requestContext: context.requestContext,
    bizParams: buildSubmissionBizParams(identity),
  });
}

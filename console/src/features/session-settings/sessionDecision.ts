import { request } from "@/api/request";
import type { SessionModelScope } from "./sessionModel";

export interface DecisionSettings {
  enabled: boolean;
  configured: boolean;
  override: boolean | null;
}

const key = (agent: string, session: string) =>
  `qwenpaw-decision-enabled:${agent}:${session}`;

export function readPendingDecision(agent: string, session: string) {
  const raw = sessionStorage.getItem(key(agent, session));
  return raw === null ? null : raw === "true";
}

export function clearPendingDecision(agent: string, session: string) {
  sessionStorage.removeItem(key(agent, session));
}

export function migratePendingDecision(
  agent: string,
  from: string,
  to: string,
) {
  if (from === to) return;
  const raw = sessionStorage.getItem(key(agent, from));
  if (raw !== null) {
    sessionStorage.setItem(key(agent, to), raw);
    clearPendingDecision(agent, from);
  }
}

export function withPendingDecision(
  body: Record<string, unknown>,
  agent: string,
  session: string,
) {
  const enabled = readPendingDecision(agent, session);
  if (enabled === null) return body;
  return {
    ...body,
    request_context: {
      ...((body.request_context as Record<string, unknown>) || {}),
      session_decision_enabled: enabled,
    },
  };
}

export async function loadDecisionSettings(
  agent: string,
  scope: SessionModelScope,
) {
  const pending = readPendingDecision(agent, scope.sessionId);
  const query = new URLSearchParams();
  if (scope.chatId) query.set("chat_id", scope.chatId);
  const settings = await request<DecisionSettings>(
    `/chats/decision-settings${query.size ? `?${query}` : ""}`,
    { headers: { "X-Agent-Id": agent } },
  );
  if (pending === null) return settings;
  if (
    scope.chatId &&
    settings.override === pending &&
    readPendingDecision(agent, scope.sessionId) === pending
  ) {
    clearPendingDecision(agent, scope.sessionId);
    return settings;
  }
  return {
    ...settings,
    override: pending,
    enabled: settings.configured && pending,
  };
}

export async function saveDecisionSettings(
  agent: string,
  scope: SessionModelScope,
  enabled: boolean,
) {
  const settings = await request<DecisionSettings>(
    scope.chatId
      ? `/chats/${encodeURIComponent(scope.chatId)}/decision-settings`
      : "/chats/decision-settings",
    {
      method: "PUT",
      headers: { "X-Agent-Id": agent },
      body: JSON.stringify(enabled),
    },
  );
  if (scope.chatId) clearPendingDecision(agent, scope.sessionId);
  else sessionStorage.setItem(key(agent, scope.sessionId), String(enabled));
  return settings;
}

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button, Card, Input, Tag, Typography, Space, Tooltip } from "antd";
import {
  Shield,
  Check,
  X,
  Clock,
  Copy,
  Info,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAgentStore } from "../../stores/agentStore";
import { getAgentDisplayName } from "../../utils/agentDisplayName";
import type {
  ApprovalQuestion,
  ApprovalQuestionAnswer,
} from "../../api/modules/console";
import styles from "./ApprovalCard.module.less";

const { Text } = Typography;
const RECOMMENDED_SUFFIX = "(Recommended)";

export interface ApprovalCardProps {
  requestId: string;
  toolName: string;
  toolSource?: string;
  severity: string;
  findingsCount: number;
  findingsSummary: string;
  toolParams: Record<string, unknown>;
  // When present the card becomes an interactive question form: options are
  // selectable and the reply is sent back as `answer` on approve.
  questions?: ApprovalQuestion[];
  createdAt: number;
  timeoutSeconds: number;
  agentId: string;
  ownerAgentId?: string;
  showInboxAgentContext?: boolean;
  // One-line rationale the agent emitted before requesting this tool call.
  reasoning?: string;
  sessionId?: string;
  rootSessionId?: string;
  // Approval-scope choice (console-only). When true the card renders
  // Approve Pattern + Approve Exact; when false, a single Approve button.
  isGeneralized?: boolean;
  exactTarget?: string;
  similarTarget?: string;
  onApprove: (
    requestId: string,
    scope?: "exact" | "similar",
    answer?: string,
  ) => Promise<void>;
  onDeny: (requestId: string) => Promise<void>;
  onCancel?: () => void;
  onAcknowledge?: (requestId: string) => Promise<void>;
}

export function ApprovalCard({
  requestId,
  toolName,
  toolSource,
  severity,
  findingsCount,
  findingsSummary,
  toolParams,
  questions,
  createdAt,
  timeoutSeconds,
  agentId,
  ownerAgentId,
  showInboxAgentContext = false,
  reasoning,
  sessionId,
  rootSessionId,
  isGeneralized,
  exactTarget,
  similarTarget,
  onApprove,
  onDeny,
  onCancel: _onCancel,
  onAcknowledge,
}: ApprovalCardProps) {
  const { t } = useTranslation();
  const isAlwaysAllowDisabled = toolSource === "STRICT mode";
  const agents = useAgentStore((state) => state.agents);
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const [loading, setLoading] = useState<
    "approve-pattern" | "approve-exact" | "deny" | "acknowledge" | null
  >(null);
  const [remaining, setRemaining] = useState<number>(timeoutSeconds);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // ── Interactive question form (ask_user_question) ──────────────────
  const questionList = questions ?? [];
  const isQuestionForm = questionList.length > 0;
  const hasMultipleQuestions = questionList.length > 1;
  const [activeQuestion, setActiveQuestion] = useState(0);
  const currentQuestionIndex = Math.max(
    0,
    Math.min(activeQuestion, questionList.length - 1),
  );
  const isLastQuestion = currentQuestionIndex === questionList.length - 1;
  const contentRef = useRef<HTMLDivElement>(null);
  const questionTextRef = useRef<HTMLSpanElement>(null);
  const lastQuestionIndex = useRef(currentQuestionIndex);
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});

  const answerOf = useCallback(
    (qidx: number): string => {
      const chosen = picks[qidx] ?? [];
      if (chosen.length) return chosen.join(", ");
      return (freeText[qidx] ?? "").trim();
    },
    [picks, freeText],
  );

  const toggleOption = useCallback(
    (qidx: number, label: string, multi?: boolean) => {
      setFreeText((prev) => ({ ...prev, [qidx]: "" }));
      setPicks((prev) => {
        const current = prev[qidx] ?? [];
        if (!multi) {
          return { ...prev, [qidx]: current[0] === label ? [] : [label] };
        }
        return {
          ...prev,
          [qidx]: current.includes(label)
            ? current.filter((item) => item !== label)
            : [...current, label],
        };
      });
    },
    [],
  );

  const typeAnswer = useCallback((qidx: number, value: string) => {
    setPicks((prev) => ({ ...prev, [qidx]: [] }));
    setFreeText((prev) => ({ ...prev, [qidx]: value }));
  }, []);

  const allAnswered = useMemo(
    () =>
      questionList.length > 0 &&
      questionList.every((_, idx) => answerOf(idx).length > 0),
    [questionList, answerOf],
  );
  const currentQuestionAnswered = answerOf(currentQuestionIndex).length > 0;

  useEffect(() => {
    const changedQuestion = lastQuestionIndex.current !== currentQuestionIndex;
    lastQuestionIndex.current = currentQuestionIndex;
    if (contentRef.current) contentRef.current.scrollTop = 0;
    if (changedQuestion) {
      questionTextRef.current?.focus({ preventScroll: true });
    }
  }, [currentQuestionIndex]);

  const buildAnswerPayload = useCallback(() => {
    const answers = questionList.map(
      (question, idx): ApprovalQuestionAnswer => ({
        question: question.question,
        selected: picks[idx] ?? [],
        other: (freeText[idx] ?? "").trim() || null,
      }),
    );
    return JSON.stringify(answers);
  }, [questionList, picks, freeText]);

  const previewOf = useCallback(
    (qidx: number): string => {
      if (questionList[qidx]?.multi_select) return "";
      const chosen = picks[qidx] ?? [];
      const hit = (questionList[qidx]?.options ?? []).find(
        (option) => chosen.includes(option.label) && option.preview,
      );
      return hit?.preview ?? "";
    },
    [questionList, picks],
  );

  const handleCopy = useCallback(async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      /* clipboard not available */
    }
  }, []);

  // Check if this is a cross-session approval
  const isCrossSession =
    sessionId && rootSessionId && sessionId !== rootSessionId;
  const isTimedOut =
    (showInboxAgentContext || isQuestionForm) && remaining <= 0;
  const executionAgentDisplayName = useMemo(() => {
    const matched = agentsById.get(agentId);
    if (matched) return getAgentDisplayName(matched, t);
    return agentId || t("common.unknown", "Unknown");
  }, [agentsById, agentId, t]);
  const ownerAgentDisplayName = useMemo(() => {
    const ownerId = ownerAgentId || agentId;
    const matched = agentsById.get(ownerId);
    if (matched) return getAgentDisplayName(matched, t);
    return ownerId || t("common.unknown", "Unknown");
  }, [agentsById, ownerAgentId, agentId, t]);
  const shouldShowExecutionAgent =
    showInboxAgentContext && Boolean(isCrossSession);
  const hasOwnerAgentIdentity = Boolean(ownerAgentId || agentId);
  const displayToolSource =
    toolSource && toolSource !== "builtin"
      ? toolSource
      : t("approval.builtinSource", "Built-in");

  useEffect(() => {
    const elapsed = Date.now() / 1000 - createdAt;
    const initialRemaining = Math.max(0, Math.floor(timeoutSeconds - elapsed));
    setRemaining(initialRemaining);

    const timer = setInterval(() => {
      const newElapsed = Date.now() / 1000 - createdAt;
      const newRemaining = Math.max(0, Math.floor(timeoutSeconds - newElapsed));
      setRemaining(newRemaining);

      if (newRemaining <= 0) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [createdAt, timeoutSeconds]);

  const handleApprove = async (scope?: "exact" | "similar") => {
    if (isQuestionForm && (!isLastQuestion || !allAnswered || isTimedOut))
      return;
    const loadingKey =
      scope === "similar" ? "approve-pattern" : "approve-exact";
    console.log(
      "[ApprovalCard] Approve button clicked:",
      requestId,
      "scope:",
      scope,
    );
    setLoading(loadingKey);
    try {
      if (isQuestionForm) {
        await onApprove(requestId, scope, buildAnswerPayload());
      } else {
        await onApprove(requestId, scope);
      }
      console.log("[ApprovalCard] onApprove completed");
    } catch (err) {
      console.error("[ApprovalCard] onApprove failed:", err);
    } finally {
      setLoading(null);
    }
  };

  const handleDeny = async () => {
    setLoading("deny");
    try {
      await onDeny(requestId);
    } finally {
      setLoading(null);
    }
  };

  const handleAcknowledge = async () => {
    if (!onAcknowledge) return;
    setLoading("acknowledge");
    try {
      await onAcknowledge(requestId);
    } finally {
      setLoading(null);
    }
  };

  const getSeverityColor = (sev: string) => {
    const s = sev.toLowerCase();
    if (s === "critical" || s === "high") return "error";
    if (s === "medium") return "warning";
    return "default";
  };

  return (
    <Card className={styles.approvalCard} bordered={false}>
      <div className={styles.header}>
        <Space size={8} align="center" className={styles.titleRow}>
          {isQuestionForm ? (
            <Info size={16} className={styles.icon} />
          ) : (
            <Shield size={16} className={styles.icon} />
          )}
          <Text className={styles.title}>
            {isQuestionForm
              ? t("approval.questionTitle", "Your input is needed")
              : t("approval.title", "Security Approval Required")}
          </Text>
          {hasMultipleQuestions ? (
            <Text className={styles.questionProgress} aria-live="polite">
              {t("approval.questionProgress", "{{current}} / {{total}}", {
                current: currentQuestionIndex + 1,
                total: questionList.length,
              })}
            </Text>
          ) : null}
        </Space>
        <Space size={6} align="center" className={styles.timer}>
          <Clock size={14} className={styles.timerIcon} />
          <Text className={styles.timerText}>
            {Math.floor(remaining / 60)}:
            {String(remaining % 60).padStart(2, "0")}
          </Text>
        </Space>
      </div>

      <div className={styles.content} ref={contentRef}>
        {isQuestionForm && (
          <div className={styles.questionList}>
            {questionList.map((q, qidx) =>
              qidx === currentQuestionIndex ? (
                <div className={styles.questionItem} key={qidx}>
                  <div className={styles.questionHead}>
                    {q.header ? <Tag>{q.header}</Tag> : null}
                    <Text
                      className={styles.questionTitle}
                      ref={questionTextRef}
                      role="heading"
                      aria-level={3}
                      tabIndex={-1}
                    >
                      {q.question}
                    </Text>
                  </div>
                  {q.context ? (
                    <pre className={styles.questionContext}>{q.context}</pre>
                  ) : null}
                  {(q.options?.length ?? 0) > 0 && (
                    <div className={styles.optionList}>
                      {q.options?.map((opt) => {
                        const isRecommended =
                          opt.label.endsWith(RECOMMENDED_SUFFIX);
                        const displayLabel = isRecommended
                          ? opt.label
                              .slice(0, -RECOMMENDED_SUFFIX.length)
                              .trimEnd()
                          : opt.label;
                        return (
                          <Button
                            key={opt.label}
                            size="small"
                            block
                            type={
                              (picks[qidx] ?? []).includes(opt.label)
                                ? "primary"
                                : "default"
                            }
                            className={styles.optionButton}
                            disabled={loading !== null || isTimedOut}
                            aria-pressed={(picks[qidx] ?? []).includes(
                              opt.label,
                            )}
                            onClick={() =>
                              toggleOption(qidx, opt.label, q.multi_select)
                            }
                          >
                            <span className={styles.optionLabel}>
                              {displayLabel}
                              {isRecommended ? (
                                <Tag
                                  color="success"
                                  className={styles.recommendedTag}
                                >
                                  {t("approval.recommended", "Recommended")}
                                </Tag>
                              ) : null}
                            </span>
                            {opt.description ? (
                              <span className={styles.optionDescription}>
                                {opt.description}
                              </span>
                            ) : null}
                          </Button>
                        );
                      })}
                    </div>
                  )}
                  {previewOf(qidx) ? (
                    <pre className={styles.optionPreview}>
                      {previewOf(qidx)}
                    </pre>
                  ) : null}
                  <Input
                    size="small"
                    className={styles.questionInput}
                    disabled={loading !== null || isTimedOut}
                    aria-label={t(
                      "approval.otherAnswer",
                      "Other — type your answer",
                    )}
                    placeholder={
                      (q.options?.length ?? 0) > 0
                        ? t("approval.otherAnswer", "Other — type your answer")
                        : t("approval.yourAnswer", "Your answer")
                    }
                    value={freeText[qidx] ?? ""}
                    onChange={(event) => typeAnswer(qidx, event.target.value)}
                  />
                </div>
              ) : null,
            )}
          </div>
        )}
        {showInboxAgentContext ? (
          <>
            <div className={styles.infoRow}>
              <Text className={styles.label}>
                {t("approval.ownerAgent", "Owner Agent")}:
              </Text>
              <Tag color="success" className={styles.ownerAgentTag}>
                {ownerAgentDisplayName}
              </Tag>
            </div>
            {shouldShowExecutionAgent ? (
              <div className={styles.infoRow}>
                <Text className={styles.label}>
                  {t("approval.executingAgent", "Executing Agent")}:
                </Text>
                <Tag color="blue" className={styles.crossSessionTag}>
                  {executionAgentDisplayName}
                </Tag>
              </div>
            ) : null}
          </>
        ) : hasOwnerAgentIdentity ? (
          <div className={styles.infoRow}>
            <Text className={styles.label}>
              {t("approval.agent", "Agent")}:
            </Text>
            <Tag color="success" className={styles.ownerAgentTag}>
              {ownerAgentDisplayName}
            </Tag>
          </div>
        ) : null}

        <div className={styles.infoRow}>
          <Text className={styles.label}>{t("approval.tool", "Tool")}:</Text>
          <Text className={styles.value} code>
            {toolName}
          </Text>
        </div>

        <div className={styles.infoRow}>
          <Text className={styles.label}>
            {t("approval.source", "Source")}:
          </Text>
          <Text className={styles.value} code>
            {displayToolSource}
          </Text>
        </div>

        <div className={styles.infoRow}>
          <Text className={styles.label}>
            {t("approval.severity", "Severity")}:
          </Text>
          <Tag
            color={getSeverityColor(severity)}
            className={styles.severityTag}
          >
            {severity.toUpperCase()}
          </Tag>
        </div>

        <div className={styles.infoRow}>
          <Text className={styles.label}>
            {t("approval.findings", "Findings")}:
          </Text>
          <Text className={styles.value}>{findingsCount}</Text>
        </div>

        {reasoning ? (
          <div className={styles.reasoningRow}>
            <Text className={styles.label}>
              {t("approval.reason", "Reason")}:
            </Text>
            <Text
              className={styles.reasoningText}
            >{`\u201C${reasoning}\u201D`}</Text>
          </div>
        ) : null}

        {isCrossSession && !showInboxAgentContext && (
          <div className={styles.infoRow}>
            <Text className={styles.label}>
              {t("approval.source", "Source")}:
            </Text>
            <Tag color="blue" className={styles.crossSessionTag}>
              {t("approval.subSession", "Sub-Agent")} ({sessionId?.slice(0, 8)})
            </Tag>
          </div>
        )}

        {isGeneralized && (exactTarget || similarTarget) && (
          <div className={styles.scopeSection}>
            <Text className={styles.scopeLabel}>
              {t("approval.approvalScope", "Approval scope")}:
            </Text>
            <div className={styles.scopeItems}>
              <div className={styles.scopeItem}>
                <Text className={styles.scopeItemLabel}>
                  {t("approval.approveExact", "Just Once")}:
                </Text>
                <code className={styles.scopeCode}>{exactTarget}</code>
              </div>
              <div className={styles.scopeItem}>
                <Text className={styles.scopeItemLabel}>
                  {t("approval.approvePattern", "Always Allow")}:
                </Text>
                <code className={styles.scopeCode}>{similarTarget}</code>
                {isAlwaysAllowDisabled && (
                  <Tooltip
                    title={t(
                      "approval.alwaysAllowDisabledHint",
                      "Always allow is unavailable for this approval source",
                    )}
                  >
                    <AlertCircle
                      size={14}
                      className={styles.strictModeHintIcon}
                    />
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
        )}

        {toolParams && Object.keys(toolParams).length > 0 && (
          <details className={styles.paramsDetails}>
            <summary className={styles.paramsSummary}>
              {t("approval.parameters", "Parameters")}
            </summary>
            <div className={styles.paramsCodeWrapper}>
              <pre className={styles.paramsCode}>
                {JSON.stringify(toolParams, null, 2)}
              </pre>
              <button
                className={`${styles.copyButton} ${
                  copiedField === "params" ? styles.copied : ""
                }`}
                onClick={() =>
                  handleCopy(JSON.stringify(toolParams, null, 2), "params")
                }
                title={t("common.copy", "Copy")}
              >
                <Copy size={12} />
              </button>
            </div>
          </details>
        )}

        {findingsSummary && (
          <details className={styles.detailsSection}>
            <summary className={styles.detailsSummary}>
              <Info size={12} />
              {t("approval.details", "Details")}
            </summary>
            <div className={styles.detailsContent}>
              <pre className={styles.detailsText}>{findingsSummary}</pre>
              <button
                className={`${styles.copyButton} ${
                  copiedField === "details" ? styles.copied : ""
                }`}
                onClick={() => handleCopy(findingsSummary, "details")}
                title={t("common.copy", "Copy")}
              >
                <Copy size={12} />
              </button>
            </div>
          </details>
        )}
      </div>

      <div className={styles.actions}>
        {isTimedOut ? (
          <>
            <Text className={styles.timeoutHint}>
              {t("approval.timeoutAutoDenied", "Timed out, auto denied")}
            </Text>
            {onAcknowledge ? (
              <Button
                type="primary"
                onClick={handleAcknowledge}
                loading={loading === "acknowledge"}
                disabled={loading !== null}
              >
                {t("approval.acknowledge", "Got It")}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button
              danger
              icon={<X size={14} />}
              onClick={handleDeny}
              loading={loading === "deny"}
              disabled={loading !== null}
              className={styles.denyButton}
            >
              {t("approval.deny", "Deny")}
            </Button>
            {isQuestionForm ? (
              <div className={styles.questionNavigation}>
                {hasMultipleQuestions ? (
                  <Button
                    icon={<ChevronLeft size={14} />}
                    onClick={() => setActiveQuestion(currentQuestionIndex - 1)}
                    disabled={loading !== null || currentQuestionIndex === 0}
                  >
                    {t("approval.previousQuestion", "Previous question")}
                  </Button>
                ) : null}
                {isLastQuestion ? (
                  <Button
                    type="primary"
                    icon={<Check size={14} />}
                    onClick={() => handleApprove()}
                    loading={loading === "approve-exact"}
                    disabled={loading !== null || !allAnswered}
                    className={styles.approveOnceButton}
                  >
                    {t("approval.submitAnswer", "Submit answer")}
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    onClick={() => {
                      if (currentQuestionAnswered && !isTimedOut) {
                        setActiveQuestion(currentQuestionIndex + 1);
                      }
                    }}
                    disabled={loading !== null || !currentQuestionAnswered}
                  >
                    {t("approval.nextQuestion", "Next question")}
                    <ChevronRight size={14} />
                  </Button>
                )}
              </div>
            ) : isGeneralized ? (
              <>
                <Button
                  type="primary"
                  icon={<Check size={14} />}
                  onClick={() => handleApprove("exact")}
                  loading={loading === "approve-exact"}
                  disabled={loading !== null}
                  className={styles.approveOnceButton}
                >
                  {t("approval.approveExact", "Just Once")}
                </Button>
                <Tooltip
                  title={
                    isAlwaysAllowDisabled
                      ? t(
                          "approval.alwaysAllowDisabledHint",
                          "Always allow is unavailable for this approval source",
                        )
                      : undefined
                  }
                >
                  <Button
                    onClick={() => handleApprove("similar")}
                    loading={loading === "approve-pattern"}
                    disabled={isAlwaysAllowDisabled || loading !== null}
                    className={styles.approveAlwaysButton}
                  >
                    {t("approval.approvePattern", "Always Allow")}
                  </Button>
                </Tooltip>
              </>
            ) : (
              <Button
                type="primary"
                icon={<Check size={14} />}
                onClick={() => handleApprove()}
                loading={
                  loading === "approve-exact" || loading === "approve-pattern"
                }
                disabled={loading !== null}
                className={styles.approveOnceButton}
              >
                {t("approval.approve", "Approve")}
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

# -*- coding: utf-8 -*-
"""Ask the user structured questions and block until they answer."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from agentscope.message import TextBlock, ToolResultState
from agentscope.tool import ToolChunk

from ...constant import TOOL_GUARD_APPROVAL_TIMEOUT_SECONDS
from ...runtime.tool_registry import tool_descriptor

logger = logging.getLogger(__name__)

SOURCE_TYPE = "ask_user_question"
MAX_QUESTIONS = 4
MAX_OPTIONS = 4
MAX_HEADER = 24

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)

_EXAMPLE = (
    "\n\nExpected `questions` is a JSON array, e.g.:\n"
    '```json\n[{"question": "Which scope?", "header": "Scope", '
    '"options": [{"label": "auth only", "description": ""}, '
    '{"label": "auth + session"}], "multiSelect": false}]\n```'
)


def _chunk(state: ToolResultState, text: str) -> ToolChunk:
    """Build a terminal ``ToolChunk`` carrying a single text block."""
    return ToolChunk(
        is_last=True,
        state=state,
        content=[TextBlock(type="text", text=text)],
    )


def _extract_json_array(raw: str) -> tuple[list[Any] | None, str]:
    """Parse ``raw`` into a JSON array, tolerating common model noise."""
    text = (raw or "").strip()
    if not text:
        return None, "`questions` is empty."

    fenced = _FENCE_RE.search(text)
    if fenced:
        text = fenced.group(1).strip()

    try:
        data: Any = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end <= start:
            return None, "`questions` is not valid JSON."
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            return None, f"`questions` is not valid JSON ({exc})."

    if isinstance(data, dict):
        data = data.get("questions")
    if not isinstance(data, list) or not data:
        return None, "`questions` must be a non-empty JSON array."
    return data, ""


def _normalize(raw: list[Any]) -> tuple[list[dict[str, Any]], str]:
    """Validate and canonicalize the question payload."""
    questions: list[dict[str, Any]] = []
    for idx, item in enumerate(raw[:MAX_QUESTIONS], start=1):
        if not isinstance(item, dict):
            return [], f"question #{idx} is not a JSON object."

        prompt = str(item.get("question") or "").strip()
        if not prompt:
            return [], f"question #{idx} has no `question` text."

        header = str(item.get("header") or "").strip() or f"Q{idx}"
        options = _normalize_options(item.get("options"), idx)
        if isinstance(options, str):
            return [], options

        questions.append(
            {
                "question": prompt,
                "header": header[:MAX_HEADER],
                "options": options,
                "multiSelect": bool(
                    item.get("multiSelect") or item.get("multi_select"),
                ),
            },
        )

    if not questions:
        return [], "`questions` produced no usable question."
    return questions, ""


def _normalize_options(
    raw: Any,
    qidx: int,
) -> list[dict[str, str]] | str:
    """Return option dicts or an error string."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        return f"question #{qidx} `options` must be an array."

    options: list[dict[str, str]] = []
    for opt in raw[:MAX_OPTIONS]:
        if isinstance(opt, dict):
            label = str(opt.get("label") or "").strip()
            if not label:
                continue
            options.append(
                {
                    "label": label,
                    "description": str(
                        opt.get("description") or "",
                    ).strip(),
                },
            )
            continue
        label = str(opt or "").strip()
        if label:
            options.append({"label": label, "description": ""})
    return options


def _render_text(questions: list[dict[str, Any]]) -> str:
    """Render a human-readable form used by channels and text-only UIs."""
    lines: list[str] = []
    for qnum, q in enumerate(questions, start=1):
        prefix = f"{qnum}. " if len(questions) > 1 else ""
        lines.append(f"{prefix}{q['question']}")
        for onum, opt in enumerate(q["options"], start=1):
            desc = f" — {opt['description']}" if opt["description"] else ""
            lines.append(f"   {onum}) {opt['label']}{desc}")
        if q["options"]:
            lines.append("   其他：直接输入你的答案")
    return "\n".join(lines)


def _format_answers(
    questions: list[dict[str, Any]],
    answer: str,
) -> str:
    """Pair answers with questions when the client sends them aligned."""
    try:
        parsed = json.loads(answer)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, list) and len(parsed) == len(questions):
        blocks = []
        for q, ans in zip(questions, parsed):
            blocks.append(f"Q: {q['question']}\nA: {str(ans).strip()}")
        return "The user answered:\n" + "\n".join(blocks)

    if len(questions) == 1:
        return f"Q: {questions[0]['question']}\nA: {answer}"

    return f"The user answered:\n{answer}"


def _outcome_chunk(
    decision: Any,
    pending: Any,
    questions: list[dict[str, Any]],
    timeout: float,
) -> ToolChunk:
    """Map an approval decision onto a tool result chunk."""
    from ...security.tool_guard.approval import ApprovalDecision

    if decision == ApprovalDecision.APPROVED:
        answer = (pending.answer or "").strip()
        if not answer:
            return _chunk(
                ToolResultState.SUCCESS,
                "The user confirmed but provided no answer text.",
            )
        return _chunk(
            ToolResultState.SUCCESS,
            _format_answers(questions, answer),
        )
    if decision == ApprovalDecision.DENIED:
        return _chunk(
            ToolResultState.DENIED,
            "The user declined to answer. Proceed with your best judgment "
            "and state the assumption you made.",
        )
    return _chunk(
        ToolResultState.ERROR,
        f"The user did not answer within {int(timeout)}s. Proceed with the "
        "smallest reasonable assumption and state it clearly.",
    )


@tool_descriptor(
    async_execution=True,
    tool_type="internal",
    policy_name="AskUserQuestion",
    default_policy="allow",
    policy_reason=(
        "Collects the user's own input and performs no side effects."
    ),
    ui_description="Ask the user structured questions and wait for answers",
    ui_icon="❓",
)
async def ask_user_question(questions: str) -> ToolChunk:
    """Ask the user structured questions and BLOCK until they answer.

    Use this only when you genuinely cannot proceed without the user's
    input: the request is ambiguous and a wrong guess would waste
    significant effort, a decision materially changes the outcome, or you
    need information only the user has. Do not use it to confirm work you
    could reasonably attempt yourself.

    Args:
        questions (`str`):
            A JSON array of 1-4 question objects. Each object accepts
            ``question`` (required), ``header`` (short label), ``options``
            (2-4 entries, each ``{"label": ..., "description": ...}``) and
            ``multiSelect`` (boolean). The client always offers a free-text
            fallback, so never add an "Other" option yourself.

    Returns:
        `ToolChunk`:
            The user's answers on success; an error result when the
            question could not be delivered, was declined, or timed out —
            in which case make the smallest reasonable assumption yourself
            and state it clearly instead of asking again.
    """
    from ...app.agent_context import (
        get_current_agent_id,
        get_current_approval_route,
        get_current_channel,
        get_current_root_session_id,
        get_current_session_id,
        get_current_user_id,
    )
    from ...app.approvals import get_approval_service
    from ...app.approvals.models import ApprovalRequestSummary

    data, parse_error = _extract_json_array(questions)
    if data is None:
        return _chunk(ToolResultState.ERROR, parse_error + _EXAMPLE)

    normalized, validate_error = _normalize(data)
    if not normalized:
        return _chunk(ToolResultState.ERROR, validate_error + _EXAMPLE)

    route = get_current_approval_route() or {}
    session_id = str(
        route.get("session_id") or get_current_session_id() or "",
    )
    if not session_id:
        return _chunk(
            ToolResultState.ERROR,
            "No session context is available, so the question cannot be "
            "delivered. Ask the user in plain text instead.",
        )

    agent_id = str(route.get("agent_id") or get_current_agent_id() or "")
    root_session_id = str(
        route.get("root_session_id")
        or get_current_root_session_id()
        or session_id,
    )
    tool_call_id = str(route.get("tool_call_id") or "")
    timeout = TOOL_GUARD_APPROVAL_TIMEOUT_SECONDS

    svc = get_approval_service()
    if tool_call_id:
        await svc.cancel_stale_pending_for_tool_call(session_id, tool_call_id)

    pending = await svc.create_pending_summary(
        session_id=session_id,
        root_session_id=root_session_id,
        owner_agent_id=str(
            route.get("root_agent_id") or agent_id or "unknown",
        ),
        user_id=str(route.get("user_id") or get_current_user_id() or ""),
        channel=str(route.get("channel") or get_current_channel() or ""),
        agent_id=agent_id or "unknown",
        summary=ApprovalRequestSummary(
            source_type=SOURCE_TYPE,
            name="AskUserQuestion",
            severity="low",
            findings_count=0,
            result_summary=_render_text(normalized),
            payload={"questions": normalized},
        ),
        timeout_seconds=timeout,
        extra={
            "tool_call": {
                "id": tool_call_id,
                "name": "AskUserQuestion",
                "input": {"questions": normalized},
            },
            "channel_meta": route.get("channel_meta"),
            "_channel_instance": route.get("_channel_instance"),
            **(
                {"_spawn_subagent": True}
                if route.get("_spawn_subagent")
                else {}
            ),
        },
    )

    logger.info(
        "ask_user_question waiting: session=%s request=%s questions=%d",
        session_id[:8],
        pending.request_id[:8],
        len(normalized),
    )
    decision = await svc.wait_for_approval(pending, timeout)
    return _outcome_chunk(decision, pending, normalized, timeout)

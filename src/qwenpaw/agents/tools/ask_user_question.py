# -*- coding: utf-8 -*-
"""Host-side implementation of the AgentScope AskUser contract.

The framework ships :class:`agentscope.tool.AskUser` as an *external* tool
(``is_external_tool = True``): it declares the contract but relies on
whatever drives the agent to put the question in front of a person and
inject the result back.  QwenPaw's tool adapter does not yet carry an
external-tool round-trip (``drivers/adapters/agentscope_tool.py`` pins
``is_external_tool = False``), so this module answers the same contract
from inside QwenPaw's existing execution model: the call blocks on the
approval service that already mediates tool-guard approvals, which brings
root-session routing for subagents, channel notification, resolver
identity policy and pending garbage collection along with it.

Questions and answers are validated by the framework's own models
(:class:`AskUserParams`, :class:`AskUserAnswer`) rather than a local
schema, and the answers come back in ``ToolChunk.metadata`` shaped as
:class:`AskUserMetadata`, so a caller can branch on the choice instead of
reading prose.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from agentscope.message import TextBlock, ToolResultState
from agentscope.tool import (
    AskUserAnswer,
    AskUserMetadata,
    AskUserParams,
    ToolChunk,
)
from pydantic import ValidationError

from ...constant import TOOL_GUARD_APPROVAL_TIMEOUT_SECONDS
from ...runtime.tool_registry import tool_descriptor

logger = logging.getLogger(__name__)

SOURCE_TYPE = "ask_user_question"
TOOL_NAME = "AskUserQuestion"
# Background flows identify themselves in the request context, including
# email-triggered runs that otherwise look like ordinary Console turns.
UNATTENDED_SOURCES = ("cron", "heartbeat", "mail_monitor")


def _no_answer_surface(route: dict[str, Any], channel: str) -> str:
    """Why nobody can answer this question, or ``""`` when somebody can.

    Blocking is only correct when a person has a surface that both shows the
    question and returns an answer.  A console session renders the card; an
    instant-messaging channel can be pushed one and answered by typing
    ``/approval approve <id> <answer>``.  Scheduled runs have nobody there,
    and an ACP or TUI permission prompt offers three fixed options without
    ever showing the question — so all of them must decline up front instead
    of holding the turn until the timeout.
    """
    if route.get("_agent_delegation") is True:
        return (
            "This turn was delegated through another agent chat, which has "
            "no answer forwarding route. Have the root agent collect the "
            "user's answer instead."
        )
    source = str(route.get("source") or "")
    if source in UNATTENDED_SOURCES:
        return (
            f"This turn was started by an unattended flow (`source={source}`),"
            " so there is no one to answer."
        )
    if not channel:
        return "This session has no chat channel to put the question in."
    if source in ("headless", "headless-task", "acp", "tui"):
        return f"This `{source}` turn has no supported answer surface."
    if channel in ("acp", "tui"):
        return f"Channel `{channel}` has no supported answer surface."
    return ""


def _chunk(
    state: ToolResultState,
    text: str,
    metadata: dict[str, Any] | None = None,
) -> ToolChunk:
    """Build a terminal ``ToolChunk`` carrying a single text block.

    ``ToolChunk.metadata`` is a required dict, so an absent payload has to
    become an empty one.
    """
    return ToolChunk(
        is_last=True,
        state=state,
        content=[TextBlock(type="text", text=text)],
        metadata=metadata or {},
    )


def _error(text: str) -> ToolChunk:
    """Build an error result the model is expected to recover from."""
    return _chunk(ToolResultState.ERROR, text)


def _strip_fence(text: str) -> str:
    """Unwrap a Markdown code fence, the same way the scroll summary does.

    Models that serialize ``questions`` into a string sometimes fence it;
    the fence is packaging, not part of the payload.
    """
    value = text.strip()
    match = re.fullmatch(
        r"```(?:json)?\s*\n(.*?)\n```",
        value,
        re.DOTALL,
    )
    return match.group(1).strip() if match else value


def _parse_questions(
    questions: list[dict[str, Any]] | str,
) -> tuple[AskUserParams | None, str]:
    """Validate the request with the framework's own ``AskUserParams``.

    A JSON string is accepted as well as a structured array, because
    models sometimes serialize it.  Every other hard rule — 1-4 questions,
    2-4 options, unique question texts and option labels, 12-character
    headers — is enforced by the framework rather than restated here.
    ``preview`` being single-select only is documented but not validated by
    the framework, so it is passed through unchanged instead of inventing a
    local rule.
    """
    payload: Any = questions
    if isinstance(payload, str):
        try:
            payload = json.loads(_strip_fence(payload) or "")
        except json.JSONDecodeError:
            return None, "`questions` is not valid JSON."
    if isinstance(payload, dict):
        payload = payload.get("questions", payload)

    try:
        return AskUserParams.model_validate({"questions": payload}), ""
    except ValidationError as exc:
        return None, "; ".join(
            f"{'.'.join(str(part) for part in err['loc'])}: {err['msg']}"
            for err in exc.errors()
        )


def _render_summary(params: AskUserParams) -> str:
    """Render the human-readable form used by channels and text-only UIs."""
    lines: list[str] = []
    for qnum, question in enumerate(params.questions, start=1):
        prefix = f"{qnum}. " if len(params.questions) > 1 else ""
        if question.context:
            lines.append(question.context)
        lines.append(f"{prefix}{question.question}")
        for onum, option in enumerate(question.options, start=1):
            desc = f" — {option.description}" if option.description else ""
            lines.append(f"   {onum}) {option.label}{desc}")
        lines.append("   其他：直接输入你的答案")
    return "\n".join(lines)


def _known_labels(question: Any, selected: Any) -> list[str]:
    """Keep only the options this question actually offered.

    ``selected`` arrives from a client, so an unknown label is either a bug
    or an attempt to make the host relabel what the user chose.  Neither may
    reach the model as though the person had said it.  A single-select
    question keeps one label: the contract calls its options mutually
    exclusive, so a client that sent several is not believed.
    """
    offered = [str(option.label) for option in question.options]
    if not isinstance(selected, (list, tuple)):
        return []
    chosen = list(
        dict.fromkeys(
            item
            for item in selected
            if isinstance(item, str) and item in offered
        ),
    )
    if not question.multi_select:
        return chosen[:1]
    return chosen


def _answer_from_text(question: Any, text: str) -> AskUserAnswer:
    """Interpret a reply that is just words.

    A reply that reads as option numbers ("2", "1, 3") is resolved against
    the numbering :func:`_render_summary` gave the human; anything else is
    free text.  Numbers are only meaningful for a one-question request, so
    the caller decides when to offer this.
    """
    text = text.strip()
    if not text:
        return AskUserAnswer(question=question.question)
    selected = _numbered_labels(text, question.options)
    if selected is not None:
        return AskUserAnswer(
            question=question.question,
            selected=_known_labels(question, selected),
        )
    return AskUserAnswer(question=question.question, other=text)


def _answer_for_question(question: Any, item: Any) -> AskUserAnswer:
    """Map one reply entry onto the framework's answer model.

    ``item`` is ``None`` when the client answered fewer questions than were
    asked; a missing answer stays missing instead of borrowing another
    question's reply.  A blank ``other`` becomes ``None`` rather than ``""``,
    because the contract distinguishes "typed nothing" from "typed
    something".
    """
    if item is None:
        return AskUserAnswer(question=question.question)
    if isinstance(item, dict):
        selected = _known_labels(question, item.get("selected"))
        other = item.get("other")
        other = other.strip() if isinstance(other, str) else ""
        return AskUserAnswer(
            question=question.question,
            selected=selected,
            other=other or None,
        )
    if isinstance(item, (list, tuple)):
        selected = _known_labels(question, list(item))
        return AskUserAnswer(question=question.question, selected=selected)
    return _answer_from_text(question, str(item))


_NUMBER_REPLY_RE = re.compile(r"^(\d+)\s*[).、]?$")


def _numbered_labels(raw: str, options: list[Any]) -> list[str] | None:
    """Resolve a "2" or "1, 3" chat reply to the labels it was numbered by.

    :func:`_render_summary` numbers the options for the human reader, so a
    chat reply carrying only those numbers is an answer to that list.  The
    model never sees the list, so a bare digit has to be mapped back here or
    it arrives as information-free noise.
    """
    labels: list[str] = []
    for token in re.split(r"[,，、/]+", raw.strip()):
        match = _NUMBER_REPLY_RE.match(token.strip())
        if not match:
            return None
        index = int(match.group(1)) - 1
        if not 0 <= index < len(options):
            continue
        labels.append(str(options[index].label))
    return labels


def _coerce_answers(
    params: AskUserParams,
    raw: str,
) -> list[AskUserAnswer]:
    """Turn whatever the client sent into framework-shaped answers.

    A current console sends one ``AskUserAnswer`` object per question as a
    JSON array, correlated by question text. Older arrays without question
    fields remain positional. Plain text can only answer a single question;
    a batch needs an array so that one reply cannot be assigned to other
    questions. Missing or unrecognized answers stay empty.
    """
    questions = list(params.questions)
    if not raw:
        return [AskUserAnswer(question=q.question) for q in questions]

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, dict):
        parsed = [parsed]
    if isinstance(parsed, list):
        named: dict[str, Any] = {}
        for item in parsed:
            if isinstance(item, dict) and isinstance(
                item.get("question"),
                str,
            ):
                named.setdefault(item["question"], item)
        answers = []
        for index, question in enumerate(questions):
            item = named.get(question.question)
            if item is None and index < len(parsed):
                positional = parsed[index]
                if (
                    not isinstance(positional, dict)
                    or "question" not in positional
                ):
                    item = positional
            answers.append(_answer_for_question(question, item))
        return answers
    if len(questions) == 1 and not raw.lstrip().startswith(("[", "{")):
        return [_answer_from_text(questions[0], raw)]
    return [AskUserAnswer(question=q.question) for q in questions]


def _render_output(answers: list[AskUserAnswer]) -> str:
    """Render the half the model reads.

    Only reached when at least one answer carries something; the cases
    where nothing came back are worded by :func:`_outcome_chunk`.
    """
    blocks: list[str] = []
    for answer in answers:
        chosen = ", ".join(answer.selected)
        if answer.other:
            chosen = f"{chosen} ({answer.other})" if chosen else answer.other
        blocks.append(f"Q: {answer.question}\nA: {chosen or '(no answer)'}")
    return "The user answered:\n" + "\n".join(blocks)


async def _wait_for_answer(
    svc: Any,
    pending: Any,
    timeout: float,
    call_context: Any,
) -> Any:
    """Honor single-tool cooperative cancellation while awaiting the user."""
    if call_context is None:
        return await svc.wait_for_approval(pending, timeout)
    waiter = asyncio.create_task(svc.wait_for_approval(pending, timeout))
    cancelled = asyncio.create_task(call_context.cancel_event.wait())
    try:
        done, _ = await asyncio.wait(
            (waiter, cancelled),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if cancelled in done:
            raise asyncio.CancelledError
        return await waiter
    finally:
        for task in (waiter, cancelled):
            if not task.done():
                task.cancel()
        await asyncio.gather(waiter, cancelled, return_exceptions=True)


def _outcome_chunk(
    decision: Any,
    pending: Any,
    params: AskUserParams,
    timeout: float,
) -> ToolChunk:
    """Map an approval decision onto a tool result.

    Every terminal case is distinguishable without reading prose:
    ``SUCCESS`` only when information came back, ``DENIED`` when the user
    declined, ``INTERRUPTED`` when the run was stopped, ``ERROR`` with
    ``answers`` in the metadata when the user approved without choosing,
    and ``ERROR`` with empty metadata whenever no answer was ever delivered
    (timeout, replay, undeliverable request).
    """
    from ...security.tool_guard.approval import ApprovalDecision

    status = str(getattr(pending, "status", "") or "")

    if decision == ApprovalDecision.APPROVED:
        answers = _coerce_answers(params, (pending.answer or "").strip())
        metadata = AskUserMetadata(answers=answers).model_dump()
        if not all(answer.selected or answer.other for answer in answers):
            if any(answer.selected or answer.other for answer in answers):
                text = (
                    "The user answered only part of the question batch. Use "
                    "only the answers below; do not treat missing answers as "
                    "choices or copy another question's answer into them.\n"
                    + _render_output(answers)
                )
            else:
                text = (
                    "The user approved without answering, so no information "
                    "came back. Make the smallest reasonable assumption and "
                    "state it."
                )
            return _chunk(
                ToolResultState.ERROR,
                text,
                metadata,
            )
        return _chunk(
            ToolResultState.SUCCESS,
            _render_output(answers),
            metadata,
        )

    if status == "cancelled":
        # Set by ``cancel_all_pending_by_root_session`` when the user stops
        # the run; "proceed anyway" would be the opposite of that request.
        return _chunk(
            ToolResultState.INTERRUPTED,
            "The run was stopped before the question was answered. Do not "
            "start new work; report what is already known.",
        )

    if status == "delivery_failed":
        return _error(
            "The question could not be delivered to the user's channel, so "
            "no answer was collected. State the missing information instead "
            "of treating this as a user choice.",
        )

    if decision == ApprovalDecision.DENIED:
        return _chunk(
            ToolResultState.DENIED,
            "The user declined to answer. Proceed with your best judgment "
            "and state the assumption you made.",
        )

    superseded = (
        " This copy was superseded by a newer one for the same tool call; "
        "ignore it."
        if status == "superseded"
        else ""
    )
    return _error(
        f"The user did not answer within {int(timeout)}s.{superseded} "
        "Proceed with the smallest reasonable assumption and state it.",
    )


@tool_descriptor(
    async_execution=True,
    input_schema=AskUserParams,
    tool_type="internal",
    policy_name="AskUserQuestion",
    default_policy="allow",
    policy_reason=(
        "Collects the user's own input and performs no side effects; the "
        "framework's AskUser is always permitted too."
    ),
    ui_description="Ask multiple-choice questions and wait for the answers",
    ui_icon="❓",
)
async def ask_user_question(
    questions: list[dict[str, Any]] | str,
) -> ToolChunk:
    """Ask the user multiple-choice questions and BLOCK until they answer.

    Use this only when you genuinely cannot proceed without the user's
    input: the request is ambiguous and a wrong guess would waste
    significant effort, a decision materially changes the outcome, or you
    need information only the user has. Do not use it to confirm work you
    could reasonably attempt yourself.

    If you recommend a specific option, place it first and append
    "(Recommended)" to its label, following the framework's AskUser rule.
    Explain the reason in that option's description. When there is no
    clear recommendation, leave the labels unmarked. Do not add a separate
    recommended field. A recommendation is a suggestion, not a user answer.

    Args:
        questions (`list[dict] | str`):
            1-4 question objects. Each needs ``question`` (unique text,
            ending in a question mark), ``header`` (a tag of at most 12
            characters), ``options`` (2-4 entries of ``{"label",
            "description"}``, optionally ``"preview"``) and
            ``multi_select``. Never add an "Other" option yourself — the
            client always provides free-text input. A JSON string is
            accepted, but prefer the structured form.

    Returns:
        `ToolChunk`:
            SUCCESS with the answers, which are also in ``metadata`` shaped
            as ``AskUserMetadata`` for callers that branch on the choice
            instead of reading prose.  DENIED when the user declined,
            INTERRUPTED when they stopped the run, and ERROR when nothing
            came back — no reply in time, an approval without a reply, or a
            turn no surface can put a question in. On denial or missing
            information, state the smallest reasonable assumption instead
            of asking again. On interruption, stop work.
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
    from ...tool_calls import get_call_context

    params, reason = _parse_questions(questions)
    if params is None:
        return _error(f"Invalid `questions`: {reason}")

    route = get_current_approval_route() or {}
    session_id = str(
        route.get("session_id") or get_current_session_id() or "",
    )
    if not session_id:
        return _error(
            "No session context is available, so the question cannot be "
            "delivered. Ask the user in plain text instead.",
        )

    agent_id = str(route.get("agent_id") or get_current_agent_id() or "")
    root_session_id = str(
        route.get("root_session_id")
        or get_current_root_session_id()
        or session_id,
    )
    channel = str(route.get("channel") or get_current_channel() or "")
    undeliverable = _no_answer_surface(route, channel)
    if undeliverable:
        return _error(
            f"{undeliverable} Ask the user in plain text instead, and state "
            "the assumption you make in place of their answer.",
        )

    call_context = get_call_context()
    tool_call_id = str(
        call_context.tool_call_id
        if call_context is not None
        else route.get("tool_call_id") or "",
    )
    timeout = TOOL_GUARD_APPROVAL_TIMEOUT_SECONDS

    svc = get_approval_service()
    owner_agent_id = str(route.get("root_agent_id") or agent_id or "unknown")
    if owner_agent_id != agent_id:
        return _error(
            "Questions from a different configured or remote agent cannot "
            "be delivered through this host's answer route. Have the root "
            "agent collect the user's answer instead; no question was queued.",
        )
    extra = {
        "tool_call": {
            "id": tool_call_id,
            "name": TOOL_NAME,
            "input": {"questions": [q.model_dump() for q in params.questions]},
        },
        "channel_meta": route.get("channel_meta"),
        "_channel_instance": route.get("_channel_instance"),
        **({"_spawn_subagent": True} if route.get("_spawn_subagent") else {}),
    }
    if channel != "console":
        notification_channel = await svc.resolve_notification_channel(
            session_id=session_id,
            root_session_id=root_session_id,
            owner_agent_id=owner_agent_id,
            agent_id=agent_id,
            channel=channel,
            extra=extra,
        )
        if notification_channel is None:
            return _error(
                f"Channel `{channel}` cannot receive an approval card here. "
                "No question was queued; state the missing information "
                "instead of waiting for an undeliverable answer.",
            )
    if tool_call_id:
        await svc.cancel_stale_pending_for_tool_call(session_id, tool_call_id)

    dumped = [question.model_dump() for question in params.questions]

    pending = await svc.create_pending_summary(
        session_id=session_id,
        root_session_id=root_session_id,
        owner_agent_id=owner_agent_id,
        user_id=str(route.get("user_id") or get_current_user_id() or ""),
        channel=channel,
        agent_id=agent_id or "unknown",
        summary=ApprovalRequestSummary(
            source_type=SOURCE_TYPE,
            name=TOOL_NAME,
            severity="low",
            findings_count=0,
            result_summary=_render_summary(params),
            payload={"questions": dumped},
        ),
        timeout_seconds=timeout,
        extra=extra,
    )

    logger.info(
        "ask_user_question waiting: session=%s request=%s questions=%d",
        session_id[:8],
        pending.request_id[:8],
        len(params.questions),
    )
    try:
        decision = await _wait_for_answer(svc, pending, timeout, call_context)
    except asyncio.CancelledError:
        # Shielding the service Future protects other resolvers, but also
        # means cancelling this one tool must explicitly retire its record.
        from ...security.tool_guard.approval import ApprovalDecision

        await asyncio.shield(
            svc.resolve_request(pending.request_id, ApprovalDecision.TIMEOUT),
        )
        raise
    return _outcome_chunk(decision, pending, params, timeout)

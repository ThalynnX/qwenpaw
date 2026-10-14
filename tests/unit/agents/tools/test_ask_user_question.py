# -*- coding: utf-8 -*-
"""Tests for the ask_user_question tool and its answer round-trip."""
# pylint: disable=protected-access,redefined-outer-name

import asyncio
import importlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from agentscope.message import ToolResultState
from agentscope.tool import AskUserMetadata

from qwenpaw.app.agent_context import (
    set_current_agent_id,
    set_current_approval_route,
    set_current_channel,
    set_current_root_session_id,
    set_current_session_id,
    set_current_user_id,
)
from qwenpaw.app.approvals.service import ApprovalService
from qwenpaw.security.tool_guard.approval import ApprovalDecision
from qwenpaw.tool_calls import (
    ToolCallContext,
    reset_call_context,
    set_call_context,
)

# `agents/tools/__init__.py` re-exports the function under the same name, so
# attribute access on the package resolves to the function, not the module.
mod = importlib.import_module("qwenpaw.agents.tools.ask_user_question")

QUESTIONS = json.dumps(
    [
        {
            "question": "要重构哪个范围？",
            "header": "Scope",
            "options": [
                {"label": "仅 auth", "description": "只动登录"},
                {"label": "auth + session", "description": "登录与会话一起动"},
            ],
            "multi_select": False,
        },
    ],
    ensure_ascii=False,
)

# A second, distinct batch, used where two requests must not cross-talk.
OTHER_QUESTIONS = json.dumps(
    [
        {
            "question": "要一起改文档吗？",
            "header": "Docs",
            "options": [
                {"label": "要", "description": "中英都改"},
                {"label": "不要", "description": "只改代码"},
            ],
        },
    ],
    ensure_ascii=False,
)


@pytest.fixture
def service(monkeypatch):
    """Give each test an isolated ApprovalService behind the singleton hook."""
    svc = ApprovalService()
    monkeypatch.setattr(
        "qwenpaw.app.approvals.get_approval_service",
        lambda: svc,
    )
    return svc


def _use_console_context():
    """Point the request context vars at a console session."""
    set_current_session_id("session-ask-1")
    set_current_root_session_id("session-ask-1")
    set_current_agent_id("agent-ask-1")
    set_current_user_id("user-ask-1")
    set_current_channel("console")
    set_current_approval_route(None)


async def _pending_request_id(svc: ApprovalService) -> str:
    """Wait until the tool has registered exactly one pending request."""
    for _ in range(200):
        if svc._pending:
            return next(iter(svc._pending))
        await asyncio.sleep(0.005)
    raise AssertionError("ask_user_question never created a pending record")


async def _wait_for_pending_count(svc: ApprovalService, count: int) -> None:
    """Wait until the service holds ``count`` pending records."""
    for _ in range(200):
        if len(svc._pending) >= count:
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"expected {count} pending records")


def _text_of(chunk) -> str:
    return "".join(
        block.get("text", "") if isinstance(block, dict) else block.text
        for block in chunk.content
    )


async def _resolve_and_wait(svc, request_id, task, answer):
    """Resolve from the UI side, then await the tool's own result chunk."""
    await svc.resolve_request(
        request_id,
        ApprovalDecision.APPROVED,
        answer=answer,
    )
    return await asyncio.wait_for(task, timeout=1)


async def test_answer_round_trip_wakes_the_tool(service):
    """The user's answer must arrive in the same tool invocation."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))

    request_id = await _pending_request_id(service)
    pending = service._pending[request_id]
    assert pending.extra["source_type"] == "ask_user_question"
    assert pending.extra["questions"][0]["header"] == "Scope"
    assert "仅 auth" in pending.result_summary

    resolved = await service.resolve_request(
        request_id,
        ApprovalDecision.APPROVED,
        answer="仅 auth",
    )
    assert resolved is not None
    assert resolved.answer == "仅 auth"

    chunk = await task
    assert chunk.state == ToolResultState.SUCCESS
    text = _text_of(chunk)
    assert "要重构哪个范围？" in text
    assert "仅 auth" in text


async def test_answer_is_ignored_when_denied(service):
    """A denial must not smuggle an answer through."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)

    await service.resolve_request(
        request_id,
        ApprovalDecision.DENIED,
        answer="不该被采纳",
    )
    chunk = await task
    assert chunk.state == ToolResultState.DENIED
    assert "不该被采纳" not in _text_of(chunk)


async def test_timeout_reports_error(service, monkeypatch):
    """Timeout degrades to an actionable error, not a hang."""
    monkeypatch.setattr(mod, "TOOL_GUARD_APPROVAL_TIMEOUT_SECONDS", 0.05)
    _use_console_context()

    chunk = await mod.ask_user_question(QUESTIONS)

    assert chunk.state == ToolResultState.ERROR
    assert chunk.metadata == {}
    assert "did not answer" in _text_of(chunk)
    assert not service._pending


async def test_replayed_tool_call_supersedes_the_old_question(
    service,
    monkeypatch,
):
    """A replayed call must hand its tool_call id to the stale cleaner."""
    calls = []
    real = ApprovalService.cancel_stale_pending_for_tool_call

    async def spy(self, session_id, tool_call_id):
        calls.append((session_id, tool_call_id))
        return await real(self, session_id, tool_call_id)

    monkeypatch.setattr(
        ApprovalService,
        "cancel_stale_pending_for_tool_call",
        spy,
    )
    set_current_session_id("session-ask-2")
    set_current_root_session_id("session-ask-2")
    set_current_agent_id("agent-ask-2")
    set_current_channel("console")
    set_current_approval_route({"tool_call_id": "call-42"})

    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)
    await service.resolve_request(
        request_id,
        ApprovalDecision.APPROVED,
        answer="仅 auth",
    )
    await task

    assert calls == [("session-ask-2", "call-42")]
    assert not service._pending


async def test_missing_session_context_degrades_gracefully(service):
    """Without a session the tool must tell the model to ask in text."""
    set_current_session_id("")
    set_current_root_session_id("")
    set_current_agent_id("")
    set_current_channel("")
    set_current_approval_route(None)

    chunk = await mod.ask_user_question(QUESTIONS)

    assert chunk.state == ToolResultState.ERROR
    assert "plain text" in _text_of(chunk)
    assert not service._pending


@pytest.mark.parametrize(
    "raw,expect",
    [
        ("", "not valid JSON"),
        ("not json at all", "not valid JSON"),
        ("{}", "Input should be a valid list"),
        ("[]", "at least 1 item"),
        ('[{"header":"Scope"}]', "questions.0.question: Field required"),
        (
            '[{"question":"q?","header":"H","options":"oops"}]',
            "questions.0.options: Input should be a valid list",
        ),
    ],
)
async def test_bad_payloads_return_an_error(raw, expect, service):
    """Malformed model output never blocks; it returns guidance."""
    _use_console_context()
    chunk = await mod.ask_user_question(raw)
    assert chunk.state == ToolResultState.ERROR
    assert expect in _text_of(chunk)
    assert not service._pending


@pytest.mark.parametrize(
    "raw,expect",
    [
        (
            json.dumps(
                [
                    {
                        "question": "q?",
                        "header": "H",
                        "options": [{"label": "a", "description": "d"}],
                    },
                ],
            ),
            "at least 2 items",
        ),
        (
            json.dumps(
                [
                    {
                        "question": "q?",
                        "header": "x" * 13,
                        "options": [
                            {"label": "a", "description": "d"},
                            {"label": "b", "description": "d"},
                        ],
                    },
                ],
            ),
            "at most 12 characters",
        ),
        (
            json.dumps(
                [
                    {
                        "question": "q?",
                        "header": "H",
                        "options": [
                            {"label": "a", "description": "d"},
                            {"label": "a", "description": "d"},
                        ],
                    },
                ],
            ),
            "option labels must be unique",
        ),
        (
            json.dumps(
                [
                    {
                        "question": "same?",
                        "header": "H",
                        "options": [
                            {"label": "a", "description": "d"},
                            {"label": "b", "description": "d"},
                        ],
                    },
                    {
                        "question": "same?",
                        "header": "H",
                        "options": [
                            {"label": "c", "description": "d"},
                            {"label": "d", "description": "d"},
                        ],
                    },
                ],
            ),
            "question texts must be unique",
        ),
        (
            json.dumps(
                [
                    {
                        "question": f"q{k}?",
                        "header": "H",
                        "options": [
                            {"label": "a", "description": "d"},
                            {"label": "b", "description": "d"},
                        ],
                    }
                    for k in range(5)
                ],
            ),
            "at most 4 items",
        ),
        (
            '[{"question":"q?","header":"H","options":["a","b"]}]',
            "valid dictionary or instance of _Option",
        ),
    ],
)
async def test_framework_contract_rules_are_enforced(raw, expect, service):
    """The framework's ``AskUserParams`` is the single schema, so its rules
    bite here without being restated in QwenPaw code."""
    _use_console_context()
    chunk = await mod.ask_user_question(raw)
    assert chunk.state == ToolResultState.ERROR
    assert expect in _text_of(chunk)
    assert not service._pending


async def test_fenced_json_is_accepted(service):
    """Models wrap tool payloads in code fences often enough to support."""
    _use_console_context()
    raw = (
        "```json\n"
        '[{"question": "选哪个库?", "header": "Library", "options": '
        '[{"label": "httpx", "description": "同步异步都能用"}, '
        '{"label": "aiohttp", "description": "只做异步"}]}]'
        "\n```"
    )
    task = asyncio.create_task(mod.ask_user_question(raw))
    request_id = await _pending_request_id(service)
    assert service._pending[request_id].extra["questions"][0]["options"] == [
        {"label": "httpx", "description": "同步异步都能用", "preview": None},
        {"label": "aiohttp", "description": "只做异步", "preview": None},
    ]

    await service.resolve_request(
        request_id,
        ApprovalDecision.APPROVED,
        answer="httpx",
    )
    assert (await task).state == ToolResultState.SUCCESS


async def test_structured_list_input_is_accepted(service):
    """The declared input type is an array, so it must work unserialized."""
    _use_console_context()
    raw = [
        {
            "question": "先做哪个?",
            "header": "Order",
            "options": [
                {"label": "测试", "description": "先补测试"},
                {"label": "文档", "description": "先补文档"},
            ],
        },
    ]
    task = asyncio.create_task(mod.ask_user_question(raw))
    request_id = await _pending_request_id(service)
    assert service._pending[request_id].result_summary.startswith("先做哪个?")

    await service.resolve_request(
        request_id,
        ApprovalDecision.APPROVED,
        answer="测试",
    )
    assert (await task).state == ToolResultState.SUCCESS


async def test_multi_question_answers_are_paired(service):
    """Aligned answer arrays map each choice back to its question."""
    _use_console_context()
    raw = json.dumps(
        [
            {
                "question": "Q1?",
                "header": "One",
                "options": [
                    {"label": "a", "description": "d"},
                    {"label": "b", "description": "d"},
                ],
            },
            {
                "question": "Q2?",
                "header": "Two",
                "options": [
                    {"label": "c", "description": "d"},
                    {"label": "d", "description": "d"},
                ],
                "multi_select": True,
            },
        ],
        ensure_ascii=False,
    )
    task = asyncio.create_task(mod.ask_user_question(raw))
    request_id = await _pending_request_id(service)

    chunk = await _resolve_and_wait(
        service,
        request_id,
        task,
        json.dumps([{"selected": ["a"]}, {"selected": ["c", "d"]}]),
    )
    text = _text_of(chunk)
    assert text.count("Q:") == 2
    assert "Q: Q1?\nA: a" in text
    assert "Q: Q2?\nA: c, d" in text


async def test_plain_text_answer_becomes_free_text(service):
    """A channel that replies in prose maps onto ``AskUserAnswer.other``."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)

    chunk = await _resolve_and_wait(
        service,
        request_id,
        task,
        "两个都别动，先只改测试",
    )
    answers = AskUserMetadata.model_validate(chunk.metadata).answers
    assert answers[0].selected == []
    assert answers[0].other == "两个都别动，先只改测试"
    assert "两个都别动，先只改测试" in _text_of(chunk)


async def test_structured_answers_come_back_as_ask_user_metadata(service):
    """Programs branch on ``metadata`` instead of parsing the prose."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)

    chunk = await _resolve_and_wait(
        service,
        request_id,
        task,
        json.dumps([{"selected": ["仅 auth"]}]),
    )
    assert AskUserMetadata.model_validate(chunk.metadata)
    assert chunk.metadata["answers"] == [
        {
            "question": "要重构哪个范围？",
            "selected": ["仅 auth"],
            "other": None,
        },
    ]
    assert "仅 auth" in _text_of(chunk)


async def test_approve_without_an_answer_reports_no_information(service):
    """An instant-messaging Approve carries no reply, and that is not free
    text.  It must not be reported as a success: a caller has to be able to
    tell "the user chose nothing" apart from "the user chose this"."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)

    await service.resolve_request(request_id, ApprovalDecision.APPROVED)
    chunk = await task

    assert chunk.state == ToolResultState.ERROR
    assert chunk.metadata["answers"] == [
        {"question": "要重构哪个范围？", "selected": [], "other": None},
    ]
    assert AskUserMetadata.model_validate(chunk.metadata)
    assert "approved without answering" in _text_of(chunk)


async def test_unknown_option_labels_are_not_passed_through(service):
    """A client cannot invent a choice the question never offered."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)

    chunk = await _resolve_and_wait(
        service,
        request_id,
        task,
        json.dumps([{"selected": ["直接删库", "仅 auth"]}]),
    )
    assert chunk.state == ToolResultState.SUCCESS
    assert chunk.metadata["answers"][0]["selected"] == ["仅 auth"]


async def test_single_select_keeps_only_one_label(service):
    """The contract calls options mutually exclusive, so a client that sent
    two for a single-select question is not believed."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)

    chunk = await _resolve_and_wait(
        service,
        request_id,
        task,
        json.dumps([{"selected": ["仅 auth", "auth + session"]}]),
    )
    assert chunk.metadata["answers"][0]["selected"] == ["仅 auth"]


async def test_multi_select_keeps_every_known_label(service):
    _use_console_context()
    raw = json.dumps(
        [
            {
                "question": "要改哪些面？",
                "header": "Surfaces",
                "multi_select": True,
                "options": [
                    {"label": "console", "description": "网页控制台"},
                    {"label": "desktop", "description": "桌面壳"},
                ],
            },
        ],
    )
    task = asyncio.create_task(mod.ask_user_question(raw))
    request_id = await _pending_request_id(service)

    chunk = await _resolve_and_wait(
        service,
        request_id,
        task,
        json.dumps([{"selected": ["console", "desktop"]}]),
    )
    assert chunk.metadata["answers"][0]["selected"] == ["console", "desktop"]


async def test_missing_answers_stay_missing(service):
    """A client that answered one of two questions must not have that reply
    copied onto the other."""
    _use_console_context()
    raw = json.dumps(
        [
            {
                "question": "Q1?",
                "header": "One",
                "options": [
                    {"label": "a", "description": "d"},
                    {"label": "b", "description": "d"},
                ],
            },
            {
                "question": "Q2?",
                "header": "Two",
                "options": [
                    {"label": "c", "description": "d"},
                    {"label": "d", "description": "d"},
                ],
            },
        ],
    )
    task = asyncio.create_task(mod.ask_user_question(raw))
    request_id = await _pending_request_id(service)

    chunk = await _resolve_and_wait(
        service,
        request_id,
        task,
        json.dumps([{"selected": ["a"]}, {"selected": ["zzz"]}]),
    )
    answers = chunk.metadata["answers"]
    assert chunk.state == ToolResultState.ERROR
    assert answers[0]["selected"] == ["a"]
    assert answers[1] == {"question": "Q2?", "selected": [], "other": None}
    assert "Q: Q2?\nA: (no answer)" in _text_of(chunk)


async def test_numbered_reply_maps_to_the_option_label(service):
    """A chat reply of "2" answers the numbered list the human was shown."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)

    chunk = await _resolve_and_wait(service, request_id, task, "2")
    assert chunk.metadata["answers"][0]["selected"] == ["auth + session"]
    assert chunk.metadata["answers"][0]["other"] is None


async def test_prose_reply_stays_prose(service):
    """A reply that is not a number is the user's own words, unedited."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)

    chunk = await _resolve_and_wait(service, request_id, task, "先别动，等我确认")
    answers = chunk.metadata["answers"]
    assert answers[0]["selected"] == []
    assert answers[0]["other"] == "先别动，等我确认"


async def test_repeated_submission_does_not_rewrite_the_answer(service):
    """A second click resolves nothing and must not change what the tool
    already received."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)

    await service.resolve_request(
        request_id,
        ApprovalDecision.APPROVED,
        answer=json.dumps([{"selected": ["仅 auth"]}]),
    )
    chunk = await task
    again = await service.resolve_request(
        request_id,
        ApprovalDecision.APPROVED,
        answer=json.dumps([{"selected": ["auth + session"]}]),
    )

    assert again is None
    assert chunk.metadata["answers"][0]["selected"] == ["仅 auth"]


async def test_one_plain_string_per_question_is_accepted(service):
    """A caller may answer the batch with a bare array of strings."""
    _use_console_context()
    raw = json.dumps(
        [
            {
                "question": "Q1?",
                "header": "One",
                "options": [
                    {"label": "a", "description": "d"},
                    {"label": "b", "description": "d"},
                ],
            },
            {
                "question": "Q2?",
                "header": "Two",
                "multi_select": True,
                "options": [
                    {"label": "c", "description": "d"},
                    {"label": "d", "description": "d"},
                ],
            },
        ],
    )
    task = asyncio.create_task(mod.ask_user_question(raw))
    request_id = await _pending_request_id(service)

    chunk = await _resolve_and_wait(
        service,
        request_id,
        task,
        json.dumps(["a", ["c", "d"]]),
    )
    answers = AskUserMetadata.model_validate(chunk.metadata).answers
    assert answers[0].other == "a"
    assert answers[1].selected == ["c", "d"]


async def test_question_from_a_subagent_reaches_the_root_session(service):
    """A spawned child's question must be answerable from the parent chat.

    The tool inherits the approval service's root-session routing instead
    of inventing its own, so a subagent's question is visible to the root
    session rather than stranded in a session nobody renders.
    """
    set_current_session_id("root-ask")
    set_current_root_session_id("root-ask")
    set_current_agent_id("agent-ask")
    set_current_user_id("user-ask")
    set_current_channel("console")
    set_current_approval_route(
        {
            "session_id": "child-ask",
            "root_session_id": "root-ask",
            "agent_id": "agent-ask",
            "root_agent_id": "agent-ask",
            "user_id": "user-ask",
            "channel": "console",
            "_spawn_subagent": True,
        },
    )

    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)
    pending = service._pending[request_id]
    assert pending.session_id == "child-ask"
    assert pending.root_session_id == "root-ask"
    assert pending.extra["_spawn_subagent"] is True

    visible = await service.get_pending_by_root_session("root-ask")
    assert [p.request_id for p in visible] == [request_id]

    chunk = await _resolve_and_wait(
        service,
        request_id,
        task,
        json.dumps([{"selected": ["auth + session"]}]),
    )
    assert chunk.state == ToolResultState.SUCCESS
    assert "auth + session" in _text_of(chunk)
    assert not service._pending


async def test_stopped_run_is_reported_as_interrupted_not_declined(service):
    """/stop auto-denies pending records; the tool must not read that as a
    refusal to answer and tell the model to keep working."""
    _use_console_context()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    await _pending_request_id(service)

    assert await service.cancel_all_pending_by_root_session(
        "session-ask-1",
    )
    chunk = await task

    assert chunk.state == ToolResultState.INTERRUPTED
    assert chunk.metadata == {}
    assert "stopped" in _text_of(chunk)
    assert not service._pending


async def test_two_concurrent_questions_do_not_share_answers(service):
    """A reply must wake only the request it was addressed to."""
    _use_console_context()
    first = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    first_id = await _pending_request_id(service)
    second = asyncio.create_task(mod.ask_user_question(OTHER_QUESTIONS))
    await _wait_for_pending_count(service, 2)
    second_id = next(rid for rid in service._pending if rid != first_id)

    await service.resolve_request(
        second_id,
        ApprovalDecision.APPROVED,
        answer=json.dumps([{"selected": ["不要"]}]),
    )
    second_chunk = await second
    assert not first.done()
    assert "要一起改文档吗？" in _text_of(second_chunk)
    assert "要重构哪个范围？" not in _text_of(second_chunk)

    first_chunk = await _resolve_and_wait(
        service,
        first_id,
        first,
        json.dumps([{"selected": ["仅 auth"]}]),
    )
    assert "要重构哪个范围？" in _text_of(first_chunk)
    assert first_chunk.metadata["answers"][0]["selected"] == ["仅 auth"]
    assert second_chunk.metadata["answers"][0]["selected"] == ["不要"]
    assert not service._pending


@pytest.mark.parametrize(
    "route,expect",
    [
        (
            {"channel": "console", "source": "cron"},
            "unattended flow",
        ),
        (
            {"channel": "console", "source": "heartbeat"},
            "unattended flow",
        ),
        (
            {"channel": ""},
            "no chat channel",
        ),
        (
            {"channel": "dingtalk"},
            "cannot receive an approval card",
        ),
    ],
)
async def test_turns_nobody_can_answer_exit_before_waiting(
    route,
    expect,
    service,
):
    """Blocking is only honest when some surface can show the question and
    return a reply; otherwise the tool must say so immediately."""
    set_current_session_id("session-ask-3")
    set_current_root_session_id("session-ask-3")
    set_current_agent_id("agent-ask-3")
    set_current_channel(route["channel"])
    set_current_approval_route(route)

    chunk = await mod.ask_user_question(QUESTIONS)

    assert chunk.state == ToolResultState.ERROR
    assert expect in _text_of(chunk)
    assert chunk.metadata == {}
    assert not service._pending


def test_answer_field_is_exposed_on_the_api_schema():
    """The console sends `answer` through the existing approve endpoint."""
    from qwenpaw.app.routers.approval import ApprovalActionRequest

    assert "answer" in ApprovalActionRequest.model_fields


def _batch_params():
    questions = json.loads(QUESTIONS) + json.loads(OTHER_QUESTIONS)
    params, error = mod._parse_questions(questions)
    assert not error
    return params


@pytest.mark.parametrize(
    "raw",
    [
        "a reply without a question identity",
        '[{"selected": ["仅 auth"]}',
        "[]",
        '[{"question": "unknown question", "selected": ["仅 auth"]}]',
    ],
)
def test_uncorrelated_batch_answers_are_not_copied(raw):
    answers = mod._coerce_answers(_batch_params(), raw)
    assert len(answers) == 2
    assert all(
        not answer.selected and answer.other is None for answer in answers
    )


def test_named_answers_follow_question_identity_instead_of_array_order():
    params = _batch_params()
    answers = mod._coerce_answers(
        params,
        json.dumps(
            [
                {"question": params.questions[1].question, "selected": ["不要"]},
                {
                    "question": params.questions[0].question,
                    "selected": ["仅 auth"],
                },
            ],
        ),
    )
    assert [answer.selected for answer in answers] == [["仅 auth"], ["不要"]]
    assert [answer.question for answer in answers] == [
        question.question for question in params.questions
    ]


def test_duplicate_named_answer_cannot_overwrite_the_first_choice():
    params = _batch_params()
    answers = mod._coerce_answers(
        params,
        json.dumps(
            [
                {"question": params.questions[1].question, "selected": ["要"]},
                {"question": params.questions[1].question, "selected": ["不要"]},
            ],
        ),
    )
    assert answers[0].selected == []
    assert answers[1].selected == ["要"]


@pytest.mark.parametrize(
    "raw,expected",
    [
        ('[{"selected": ["仅 auth"]}]', [["仅 auth"], []]),
        ('[null, {"selected": ["不要"]}]', [[], ["不要"]]),
    ],
)
def test_short_or_null_positional_answers_leave_the_missing_question_empty(
    raw,
    expected,
):
    answers = mod._coerce_answers(_batch_params(), raw)
    assert [answer.selected for answer in answers] == expected
    assert all(answer.other is None for answer in answers)


@pytest.mark.parametrize("multi_select", [False, True])
@pytest.mark.parametrize(
    "raw",
    [
        "2,1,2,99",
        "2, 1, 2, 99",
        '[{"selected":["auth + session","仅 auth",'
        '"auth + session","unknown"]}]',
    ],
)
def test_selection_cardinality_applies_to_structured_and_numeric_answers(
    multi_select,
    raw,
):
    questions = json.loads(QUESTIONS)
    questions[0]["multi_select"] = multi_select
    params, _ = mod._parse_questions(questions)
    answer = mod._coerce_answers(params, raw)[0]
    assert answer.selected == (
        ["auth + session", "仅 auth"] if multi_select else ["auth + session"]
    )
    assert answer.other is None


def test_explicit_other_preserves_numeric_free_text():
    params, _ = mod._parse_questions(QUESTIONS)
    answer = mod._coerce_answers(params, '[{"other": "2"}]')[0]
    assert answer.selected == []
    assert answer.other == "2"


@pytest.mark.parametrize(
    "raw",
    ['[{"selected":["unknown"]}]', '[["unknown"]]', "99"],
)
def test_invalid_choices_do_not_become_free_text(raw):
    params, _ = mod._parse_questions(QUESTIONS)
    answer = mod._coerce_answers(params, raw)[0]
    assert answer.selected == []
    assert answer.other is None


async def test_partial_batch_is_error_but_preserves_the_answered_question(
    service,
):
    _use_console_context()
    params = _batch_params()
    questions = [question.model_dump() for question in params.questions]
    task = asyncio.create_task(mod.ask_user_question(questions))
    request_id = await _pending_request_id(service)
    chunk = await _resolve_and_wait(
        service,
        request_id,
        task,
        json.dumps(
            [{"question": params.questions[1].question, "other": "later"}],
        ),
    )
    assert chunk.state == ToolResultState.ERROR
    answers = AskUserMetadata.model_validate(chunk.metadata).answers
    assert answers[0].selected == []
    assert answers[0].other is None
    assert answers[1].other == "later"
    assert "later" in _text_of(chunk)


def _call_context(call_id="current-call"):
    return ToolCallContext(
        tool_call_id=call_id,
        tool_name="ask_user_question",
        session_id="session-ask-1",
        agent_id="agent-ask-1",
        root_session_id="session-ask-1",
        started_at=asyncio.get_running_loop().time(),
        offload_deadline=None,
        cancel_event=asyncio.Event(),
    )


async def test_replay_uses_the_actual_tool_context_and_retires_the_old_waiter(
    service,
):
    _use_console_context()
    set_current_approval_route({"tool_call_id": "stale-route-id"})
    token = set_call_context(_call_context())
    try:
        first = asyncio.create_task(mod.ask_user_question(QUESTIONS))
        first_id = await _pending_request_id(service)
        assert (
            service._pending[first_id].extra["tool_call"]["id"]
            == "current-call"
        )
        second = asyncio.create_task(mod.ask_user_question(OTHER_QUESTIONS))
        first_chunk = await asyncio.wait_for(first, timeout=1)
        assert first_chunk.state == ToolResultState.ERROR
        assert first_chunk.metadata == {}
        assert "superseded" in _text_of(first_chunk)
        second_id = await _pending_request_id(service)
        assert second_id != first_id
        await _resolve_and_wait(service, second_id, second, "later")
        assert not service._pending
    finally:
        reset_call_context(token)


@pytest.mark.parametrize("cooperative", [False, True])
async def test_cancelling_one_tool_retires_only_its_own_pending(
    cooperative,
    service,
):
    _use_console_context()
    ctx = _call_context()
    token = set_call_context(ctx)
    try:
        task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    finally:
        reset_call_context(token)
    request_id = await _pending_request_id(service)
    pending = service._pending[request_id]
    sibling = asyncio.create_task(mod.ask_user_question(OTHER_QUESTIONS))
    await _wait_for_pending_count(service, 2)
    sibling_id = next(rid for rid in service._pending if rid != request_id)

    if cooperative:
        ctx.cancel_event.set()
    else:
        task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=1)
    assert pending.future.done()
    assert request_id not in service._pending
    assert sibling_id in service._pending
    assert not sibling.done()
    await _resolve_and_wait(service, sibling_id, sibling, "later")
    assert not service._pending


@pytest.mark.parametrize("source", ["headless", "acp", "tui", "mail_monitor"])
async def test_unattended_console_sources_do_not_queue_questions(
    source,
    service,
):
    _use_console_context()
    set_current_approval_route({"source": source})
    chunk = await mod.ask_user_question(QUESTIONS)
    assert chunk.state == ToolResultState.ERROR
    assert chunk.metadata == {}
    assert not service._pending


@pytest.mark.parametrize("registered", [False, True])
async def test_spawn_without_an_available_notification_channel_fails_early(
    registered,
    service,
):
    _use_console_context()
    set_current_session_id("child-ask")
    set_current_root_session_id("root-ask")
    set_current_channel("dingtalk")
    set_current_approval_route({"_spawn_subagent": True})
    if registered:
        service.set_channel_manager(
            SimpleNamespace(get_channel=AsyncMock(return_value=None)),
            "agent-ask-1",
        )
    chunk = await mod.ask_user_question(QUESTIONS)
    assert chunk.state == ToolResultState.ERROR
    assert "cannot receive" in _text_of(chunk)
    assert not service._pending


async def test_broken_channel_lookup_fails_without_leaving_a_question(service):
    _use_console_context()
    set_current_session_id("child-ask")
    set_current_root_session_id("root-ask")
    set_current_channel("dingtalk")
    set_current_approval_route({"_spawn_subagent": True})
    service.set_channel_manager(
        SimpleNamespace(
            get_channel=AsyncMock(side_effect=RuntimeError("offline")),
        ),
        "agent-ask-1",
    )
    chunk = await mod.ask_user_question(QUESTIONS)
    assert chunk.state == ToolResultState.ERROR
    assert not service._pending


async def test_im_notification_carries_the_answer_command_and_wakes_the_tool(
    service,
):
    _use_console_context()
    delivered = asyncio.Event()

    async def notify(**_kwargs):
        delivered.set()

    channel = SimpleNamespace(
        send_approval_notification=AsyncMock(side_effect=notify),
    )
    set_current_channel("dingtalk")
    set_current_approval_route({"_channel_instance": channel})
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _pending_request_id(service)
    await asyncio.wait_for(delivered.wait(), timeout=1)
    notification = channel.send_approval_notification.call_args.kwargs
    assert f"/approve {request_id} <answer>" in notification["result_summary"]
    assert "要重构哪个范围？" in notification["result_summary"]
    chunk = await _resolve_and_wait(service, request_id, task, "2")
    assert chunk.metadata["answers"][0]["selected"] == ["auth + session"]


async def test_existing_non_question_notifications_keep_the_original_body(
    service,
):
    channel = SimpleNamespace(send_approval_notification=AsyncMock())
    pending = SimpleNamespace(
        session_id="s",
        root_session_id="s",
        owner_agent_id="a",
        agent_id="a",
        channel="dingtalk",
        extra={"_channel_instance": channel, "source_type": "tool_guard"},
        user_id="u",
        request_id="r",
        tool_name="Bash",
        severity="high",
    )
    await service._notify_channel(pending, "original body")
    assert (
        channel.send_approval_notification.call_args.kwargs["result_summary"]
        == "original body"
    )


async def test_failed_question_delivery_unblocks_without_waiting_for_timeout(
    service,
    monkeypatch,
):
    _use_console_context()
    monkeypatch.setattr(mod, "TOOL_GUARD_APPROVAL_TIMEOUT_SECONDS", 300)
    channel = SimpleNamespace(
        send_approval_notification=AsyncMock(
            side_effect=RuntimeError("offline"),
        ),
    )
    set_current_channel("dingtalk")
    set_current_approval_route({"_channel_instance": channel})
    chunk = await asyncio.wait_for(mod.ask_user_question(QUESTIONS), timeout=1)
    assert chunk.state == ToolResultState.ERROR
    assert chunk.metadata == {}
    assert "could not be delivered" in _text_of(chunk)
    assert "within 300s" not in _text_of(chunk)
    assert not service._pending


async def test_channel_disappearing_after_preflight_retires_the_question(
    service,
):
    _use_console_context()
    set_current_session_id("child-ask")
    set_current_root_session_id("root-ask")
    set_current_channel("dingtalk")
    set_current_approval_route({"_spawn_subagent": True})
    channel = SimpleNamespace(send_approval_notification=AsyncMock())
    service.set_channel_manager(
        SimpleNamespace(get_channel=AsyncMock(side_effect=[channel, None])),
        "agent-ask-1",
    )
    chunk = await asyncio.wait_for(mod.ask_user_question(QUESTIONS), timeout=1)
    assert chunk.state == ToolResultState.ERROR
    assert chunk.metadata == {}
    assert "could not be delivered" in _text_of(chunk)
    assert not service._pending


async def test_reply_winning_a_delivery_failure_race_is_preserved(service):
    _use_console_context()
    records = []

    async def notify(**kwargs):
        pending = await service.get_request(kwargs["request_id"])
        records.append(pending)
        await service.resolve_request(
            pending.request_id,
            ApprovalDecision.APPROVED,
            answer="2",
        )
        raise RuntimeError("delivery acknowledgment failed after the reply")

    channel = SimpleNamespace(send_approval_notification=notify)
    set_current_channel("dingtalk")
    set_current_approval_route({"_channel_instance": channel})
    chunk = await asyncio.wait_for(mod.ask_user_question(QUESTIONS), timeout=1)
    assert chunk.state == ToolResultState.SUCCESS
    assert chunk.metadata["answers"][0]["selected"] == ["auth + session"]
    assert records[0].status == "approved"
    assert not service._pending


async def test_failed_non_question_delivery_does_not_auto_resolve_approval(
    service,
):
    from qwenpaw.app.approvals.models import ApprovalRequestSummary

    channel = SimpleNamespace(
        send_approval_notification=AsyncMock(
            side_effect=RuntimeError("offline"),
        ),
    )
    pending = await service.create_pending_summary(
        session_id="s",
        root_session_id="s",
        owner_agent_id="a",
        user_id="u",
        channel="console",
        agent_id="a",
        summary=ApprovalRequestSummary(
            source_type="driver_policy",
            name="Bash",
        ),
    )
    pending.channel = "dingtalk"
    pending.extra["_channel_instance"] = channel
    await service._notify_channel(pending, "original body")
    assert pending.status == "pending"
    assert not pending.future.done()
    assert await service.get_request(pending.request_id) is pending
    await service.resolve_request(pending.request_id, ApprovalDecision.DENIED)

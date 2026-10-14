# -*- coding: utf-8 -*-
"""Tests for the ask_user_question tool and its answer round-trip."""
# pylint: disable=protected-access,redefined-outer-name

import asyncio
import importlib
import json

import pytest
from agentscope.message import ToolResultState

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
                {"label": "auth + session"},
            ],
            "multiSelect": False,
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


def _text_of(chunk) -> str:
    return "".join(
        block.get("text", "") if isinstance(block, dict) else block.text
        for block in chunk.content
    )


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
        ("", "empty"),
        ("not json at all", "not valid JSON"),
        ("{}", "non-empty JSON array"),
        ('[{"header":"Scope"}]', "no `question` text"),
        ('[{"question":"q","options":"oops"}]', "`options` must be an array"),
    ],
)
async def test_bad_payloads_return_an_error(raw, expect, service):
    """Malformed model output never blocks; it returns guidance."""
    _use_console_context()
    chunk = await mod.ask_user_question(raw)
    assert chunk.state == ToolResultState.ERROR
    assert expect in _text_of(chunk)
    assert not service._pending


async def test_fenced_json_and_bare_options_are_accepted(service):
    """Code fences and string options are common model shapes."""
    _use_console_context()
    raw = (
        "```json\n"
        '[{"question": "选哪个库?", "options": ["httpx", "aiohttp"]}]'
        "\n```"
    )
    task = asyncio.create_task(mod.ask_user_question(raw))
    request_id = await _pending_request_id(service)
    assert service._pending[request_id].extra["questions"][0]["options"] == [
        {"label": "httpx", "description": ""},
        {"label": "aiohttp", "description": ""},
    ]

    await service.resolve_request(
        request_id,
        ApprovalDecision.APPROVED,
        answer="httpx",
    )
    assert (await task).state == ToolResultState.SUCCESS


async def test_multi_question_answers_are_paired(service):
    """Aligned JSON arrays map each answer back to its question."""
    _use_console_context()
    raw = json.dumps(
        [
            {"question": "Q1?", "options": [{"label": "a"}]},
            {
                "question": "Q2?",
                "options": [{"label": "b"}],
                "multiSelect": True,
            },
        ],
        ensure_ascii=False,
    )
    task = asyncio.create_task(mod.ask_user_question(raw))
    request_id = await _pending_request_id(service)

    await service.resolve_request(
        request_id,
        ApprovalDecision.APPROVED,
        answer=json.dumps(["a", '["b"]'], ensure_ascii=False),
    )
    text = _text_of(await task)
    assert text.count("Q:") == 2
    assert "Q: Q1?\nA: a" in text


def test_answer_field_is_exposed_on_the_api_schema():
    """The console sends `answer` through the existing approve endpoint."""
    from qwenpaw.app.routers.approval import ApprovalActionRequest

    assert "answer" in ApprovalActionRequest.model_fields

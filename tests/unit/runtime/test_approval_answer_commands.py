# -*- coding: utf-8 -*-
# pylint: disable=protected-access
"""Approval commands preserve answers and existing governance flags."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from qwenpaw.runtime.commands.control import (
    handle_control_command,
    parse_args,
)
from qwenpaw.runtime.commands.control.approval_handler import (
    ApproveCommandHandler,
)
from qwenpaw.runtime.commands.control.base import ControlContext


def _context() -> ControlContext:
    return ControlContext(
        workspace=SimpleNamespace(),
        payload=None,
        channel=None,
        session_id="root",
        user_id="user",
        agent_id="agent",
        args={},
    )


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("", {"action": "approve"}),
        ("--pattern", {"action": "approve", "pattern": True}),
        (
            "--exact request-1",
            {"action": "approve", "exact": True, "request_id": "request-1"},
        ),
        (
            "request-1 --pattern",
            {"action": "approve", "pattern": True, "request_id": "request-1"},
        ),
        (
            'request-1 [{"other": "keep  spaces --pattern"}]',
            {
                "action": "approve",
                "request_id": "request-1",
                "answer": '[{"other": "keep  spaces --pattern"}]',
            },
        ),
        (
            "request-1 -- -avoid  rewriting --pattern",
            {
                "action": "approve",
                "request_id": "request-1",
                "answer": "-avoid  rewriting --pattern",
            },
        ),
        (
            "-- a queue-head answer",
            {"action": "approve", "answer": "a queue-head answer"},
        ),
    ],
)
async def test_both_approve_spellings_preserve_answers(
    raw,
    expected,
    monkeypatch,
):
    """The long command and shorthand use the same parser."""
    parsed = parse_args(f"/approval approve {raw}", "/approval")
    parsed.pop("_raw_args", None)
    assert parsed == expected

    short = ApproveCommandHandler()
    delegate = AsyncMock(return_value="ok")
    monkeypatch.setattr(short._approval_handler, "_handle_approve", delegate)
    context = _context()
    context.args = {"_raw_args": raw}
    assert await short.handle(context) == "ok"
    assert context.args == expected


@pytest.mark.parametrize("prefix", ["/approve", "/approval approve"])
async def test_command_dispatch_preserves_multiline_json(prefix, monkeypatch):
    """Parsing cannot change spaces inside a JSON string or swallow flags."""
    raw = '[\n  {"selected": [], "other": "keep  this --exact"}\n]'
    received = []

    async def capture(_self, context):
        received.append(context.args)
        return "ok"

    monkeypatch.setattr(
        "qwenpaw.runtime.commands.control.approval_handler."
        "ApprovalCommandHandler._handle_approve",
        capture,
    )
    assert (
        await handle_control_command(
            f"{prefix} request-1 {raw}",
            _context(),
        )
        == "ok"
    )
    assert received[0]["answer"] == raw
    assert "exact" not in received[0]


def test_deny_and_list_parsing_stays_unchanged():
    assert parse_args("/approval deny request-1 a reason", "/approval") == {
        "_raw_args": "deny request-1 a reason",
        "action": "deny",
        "request_id": "request-1",
        "reason": "a reason",
    }
    assert parse_args("/approval list --all", "/approval")["all"] is True

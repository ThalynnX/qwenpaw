# -*- coding: utf-8 -*-
# pylint: disable=protected-access
"""Tests for ACP liveness and task-level error termination."""

from __future__ import annotations

from types import SimpleNamespace

from qwenpaw.agents.acp.server import (
    _EnvelopeTracker,
    _stop_reason_for_prompt_error,
)
from qwenpaw.schemas import MessageType, RunStatus


def _tool_start(call_id: str = "call-1"):
    return SimpleNamespace(
        object="message",
        type=MessageType.PLUGIN_CALL.value,
        status=RunStatus.Completed,
        content=[
            SimpleNamespace(
                data={
                    "call_id": call_id,
                    "name": "Bash",
                    "arguments": "{}",
                },
            ),
        ],
    )


def _tool_output(call_id: str = "call-1"):
    return SimpleNamespace(
        object="message",
        type=MessageType.PLUGIN_CALL_OUTPUT.value,
        status=RunStatus.Completed,
        content=[SimpleNamespace(data={"call_id": call_id, "output": "ok"})],
    )


def test_heartbeat_keeps_active_tool_call_alive():
    tracker = _EnvelopeTracker()
    tracker.process(_tool_start())

    updates = tracker.process(
        SimpleNamespace(object="message", type="heartbeat"),
    )

    assert len(updates) == 1
    assert updates[0].session_update == "tool_call_update"
    assert updates[0].tool_call_id == "call-1"
    assert updates[0].status == "in_progress"


def test_heartbeat_is_silent_without_active_tool():
    tracker = _EnvelopeTracker()

    assert (
        tracker.process(
            SimpleNamespace(object="message", type="heartbeat"),
        )
        == []
    )


def test_completed_tool_stops_heartbeats():
    tracker = _EnvelopeTracker()
    tracker.process(_tool_start())
    tracker.process(_tool_output())

    assert (
        tracker.process(
            SimpleNamespace(object="message", type="heartbeat"),
        )
        == []
    )


def test_content_moderation_returns_refusal():
    error = RuntimeError(
        "400 data_inspection_failed: inappropriate content",
    )

    assert _stop_reason_for_prompt_error(error) == "refusal"


def test_generic_prompt_error_returns_end_turn():
    assert _stop_reason_for_prompt_error(RuntimeError("boom")) == "end_turn"

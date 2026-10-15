# -*- coding: utf-8 -*-
"""Exercise human answers through the Console API and tool governance."""
# PolicyGuardedTool creates its callable subclass dynamically in __new__.
# pylint: disable=protected-access,redefined-outer-name,not-callable

import asyncio
import copy
import importlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from agentscope.message import ToolResultState
from agentscope.permission import PermissionBehavior
from fastapi import FastAPI

from qwenpaw.app.agent_context import (
    set_current_agent_id,
    set_current_approval_route,
    set_current_channel,
    set_current_root_session_id,
    set_current_session_id,
    set_current_user_id,
)
from qwenpaw.app.approvals.service import (
    ApprovalIdentityPolicy,
    ApprovalService,
)
from qwenpaw.app.routers.approval import router
from qwenpaw.governance import PolicyGuardedTool
from qwenpaw.governance.policy import GovernanceAction, GovernancePolicy
from qwenpaw.governance.resource_governor import ResourceGovernor
from qwenpaw.governance.tool_registry import ToolRegistry

pytestmark = pytest.mark.p1

mod = importlib.import_module("qwenpaw.agents.tools.ask_user_question")

QUESTIONS = [
    {
        "question": "Which scope?",
        "header": "Scope",
        "options": [
            {"label": "Auth", "description": "Update authentication."},
            {"label": "Session", "description": "Update sessions."},
        ],
        "multi_select": True,
    },
    {
        "question": "Which documentation?",
        "header": "Docs",
        "options": [
            {"label": "English", "description": "Update English docs."},
            {"label": "Chinese", "description": "Update Chinese docs."},
        ],
    },
]


@pytest.fixture
async def bridge(monkeypatch, tmp_path):
    """Use the real router, service, and policy without external services."""
    service = ApprovalService()
    created = asyncio.Event()
    original_create = service.create_pending_summary

    async def create_and_signal(**kwargs):
        # Forward all required keyword arguments from the real tool call.
        # pylint: disable-next=missing-kwoa
        pending = await original_create(**kwargs)
        created.set()
        return pending

    monkeypatch.setattr(service, "create_pending_summary", create_and_signal)
    monkeypatch.setattr(
        "qwenpaw.app.approvals.get_approval_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "qwenpaw.app.routers.approval.get_approval_service",
        lambda: service,
    )
    set_current_agent_id("http-agent")
    set_current_session_id("http-root")
    set_current_root_session_id("http-root")
    set_current_user_id("http-user")
    set_current_channel("console")
    set_current_approval_route(None)

    registry = ToolRegistry()
    registry.register("AskUserQuestion", "internal", "")
    registry.register_python_name("ask_user_question", "AskUserQuestion")
    registry.register("WriteFile", "file", "file_path")
    registry.register_python_name("write_file", "WriteFile")
    governor = ResourceGovernor(
        str(tmp_path),
        governance_dir=str(tmp_path / "governance"),
    )
    governor._policy = GovernancePolicy(
        execution_level="strict",
        audit_level="none",
        _registry=registry,
    )
    monkeypatch.setattr(governor, "add_approved_rule", AsyncMock())
    app = FastAPI()
    app.include_router(router, prefix="/api")
    task = None
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://console.test",
    ) as client:
        try:
            context = {
                "agent_id": "http-agent",
                "session_id": "http-root",
                "root_session_id": "http-root",
                "user_id": "http-user",
                "channel": "console",
                "approval_level": "strict",
            }
            tool = PolicyGuardedTool(
                mod.ask_user_question,
                governor=governor,
                request_context=context,
            )
            questions_schema = tool.input_schema["properties"]["questions"]
            assert questions_schema["minItems"] == 1
            assert questions_schema["maxItems"] == 4
            permission = await tool.check_permissions(
                {"questions": QUESTIONS},
            )
            assert permission.behavior == PermissionBehavior.ALLOW
            assert not service._pending
            task = asyncio.create_task(tool(questions=QUESTIONS))
            await asyncio.wait_for(created.wait(), 2)
            pending = list(service._pending.values())[0]
            assert pending.identity_policy == ApprovalIdentityPolicy.AGENT
            yield SimpleNamespace(
                client=client,
                service=service,
                task=task,
                pending=pending,
                governor=governor,
                context=context,
            )
        finally:
            await service.cancel_all_pending_by_root_session("http-root")
            if task is not None:
                await asyncio.wait_for(task, 2)


async def test_http_answer_resumes_the_original_call(bridge):
    """A root-scoped HTTP answer wakes only the waiting tool invocation."""
    response = await bridge.client.get(
        "/api/approval/list",
        params={"session_id": "http-root"},
    )
    assert response.status_code == 200
    question = response.json()["pending_approvals"][0]
    assert question["questions"][0]["multi_select"] is True
    assert not bridge.task.done()

    payload = {
        "request_id": bridge.pending.request_id,
        "session_id": "another-root",
        "answer": json.dumps(
            [
                {"question": QUESTIONS[1]["question"], "other": "Both"},
                {
                    "question": QUESTIONS[0]["question"],
                    "selected": ["Auth", "Session"],
                },
            ],
        ),
    }
    rejected = await bridge.client.post("/api/approval/approve", json=payload)
    assert rejected.status_code == 403
    assert not bridge.task.done()

    payload["session_id"] = "http-root"
    answered = await bridge.client.post("/api/approval/approve", json=payload)
    assert answered.status_code == 200
    result = await asyncio.wait_for(bridge.task, 2)
    assert result.state == ToolResultState.SUCCESS
    assert result.metadata["answers"] == [
        {
            "question": QUESTIONS[0]["question"],
            "selected": ["Auth", "Session"],
            "other": None,
        },
        {
            "question": QUESTIONS[1]["question"],
            "selected": [],
            "other": "Both",
        },
    ]
    assert not bridge.service._pending
    duplicate = await bridge.client.post("/api/approval/approve", json=payload)
    assert duplicate.status_code == 404


@pytest.mark.parametrize("action", ["approve", "deny"])
async def test_http_empty_approval_and_denial_are_not_answers(bridge, action):
    """Approval buttons cannot manufacture information the user never gave."""
    response = await bridge.client.post(
        f"/api/approval/{action}",
        json={
            "request_id": bridge.pending.request_id,
            "session_id": "http-root",
        },
    )
    assert response.status_code == 200
    result = await asyncio.wait_for(bridge.task, 2)
    if action == "deny":
        assert result.state == ToolResultState.DENIED
        assert result.metadata == {}
    else:
        assert result.state == ToolResultState.ERROR
        assert all(
            not answer["selected"] and answer["other"] is None
            for answer in result.metadata["answers"]
        )


async def test_answering_does_not_grant_future_tool_permissions(bridge):
    """Even an answer sent with pattern scope cannot become an allow rule."""
    from qwenpaw.governance.policy import ToolCallSpec

    policy = bridge.governor.policy
    before = copy.deepcopy(policy.user_rules)
    write_call = ToolCallSpec(
        tool_name="WriteFile",
        target="report.txt",
        agent_id="http-agent",
        session_id="http-root",
    )
    assert (
        bridge.governor.assert_policy(write_call).action
        == GovernanceAction.ASK
    )
    response = await bridge.client.post(
        "/api/approval/approve",
        json={
            "request_id": bridge.pending.request_id,
            "session_id": "http-root",
            "scope": "similar",
            "answer": json.dumps(
                [{"selected": ["Auth"]}, {"selected": ["English"]}],
            ),
        },
    )
    assert response.status_code == 200
    result = await asyncio.wait_for(bridge.task, 2)
    assert result.state == ToolResultState.SUCCESS
    bridge.governor.add_approved_rule.assert_not_awaited()
    assert policy.user_rules == before
    assert (
        bridge.governor.assert_policy(write_call).action
        == GovernanceAction.ASK
    )

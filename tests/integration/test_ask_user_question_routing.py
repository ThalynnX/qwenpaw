# -*- coding: utf-8 -*-
# pylint: disable=protected-access,redefined-outer-name
"""ask_user_question driven through the production request-context chain.

Nothing here hand-builds an approval route.  The route comes from
:class:`ContextVarsSetupHook`, the spawned child's request context from the
same helper ``spawn_subagent`` uses, and the pending record from
``ApprovalService``.  That chain is the only place the sub-agent and
instant-messaging routing can be seen working: a hand-injected route hides
exactly the gap it is supposed to prove closed.
"""

import asyncio
import importlib
import json
from types import SimpleNamespace

import pytest
from agentscope.message import ToolResultState

from qwenpaw.agents.tools.agent_management import _build_spawn_request_context
from qwenpaw.app.agent_context import (
    get_current_approval_route,
    get_current_channel,
    get_current_root_session_id,
    get_current_session_id,
)
from qwenpaw.app.approvals.service import (
    ApprovalService,
    _is_spawn_child_approval,
)
from qwenpaw.hooks.request_setup.contextvars_hook import ContextVarsSetupHook
from qwenpaw.runtime.builder import AgentBuilder
from qwenpaw.runtime.hooks import HookContext
from qwenpaw.runtime.commands.control import handle_control_command
from qwenpaw.runtime.commands.control.base import ControlContext
from qwenpaw.schemas import AgentRequest
from qwenpaw.security.tool_guard.approval import ApprovalDecision
from qwenpaw.tool_calls import ToolCoordinator, ToolCoordinatorMiddleware

# `agents/tools/__init__.py` re-exports the function under its own name, so
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
        },
    ],
    ensure_ascii=False,
)


class _RecordingChannel:
    """Stand-in for a channel adapter: records the cards it was pushed."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_approval_notification(self, **kwargs) -> None:
        self.sent.append(kwargs)


class _RecordingChannelManager:
    """Stand-in for the per-agent channel manager a spawned child uses."""

    def __init__(self, channel: _RecordingChannel) -> None:
        self._channel = channel
        self.looked_up: list[str] = []

    async def get_channel(self, channel_name: str):
        self.looked_up.append(channel_name)
        return self._channel


@pytest.fixture
def service(monkeypatch):
    """Give each test an isolated ApprovalService behind the singleton hook."""
    svc = ApprovalService()
    monkeypatch.setattr(
        "qwenpaw.app.approvals.get_approval_service",
        lambda: svc,
    )
    monkeypatch.setattr(
        "qwenpaw.runtime.commands.control.approval_handler."
        "get_approval_service",
        lambda: svc,
    )
    return svc


async def _answer_command(
    request_id: str,
    answer: str,
    *,
    session_id: str,
    agent_id: str,
    user_id: str,
    prefix: str = "/approve",
) -> str:
    """The same control-command entry point used by incoming IM messages."""
    context = ControlContext(
        workspace=SimpleNamespace(),
        payload={"channel": "feishu", "root_session_id": session_id},
        channel=None,
        session_id=session_id,
        user_id=user_id,
        agent_id=agent_id,
        args={},
    )
    return await handle_control_command(
        f"{prefix} {request_id} {answer}",
        context,
    )


def _hook_context(
    request: AgentRequest,
    *,
    session_id: str,
    agent_id: str,
    root_session_id: str | None = None,
    root_agent_id: str | None = None,
) -> HookContext:
    """Build the context the runtime hands to every lifecycle hook."""
    return HookContext(
        request=request,
        session_id=session_id,
        agent_id=agent_id,
        root_session_id=root_session_id or session_id,
        root_agent_id=root_agent_id or agent_id,
        workspace_dir=None,
        workspace=SimpleNamespace(),
        app_services=SimpleNamespace(),
    )


async def _start_turn(ctx: HookContext) -> None:
    """Run the real hook that opens a turn, then confirm what it published."""
    await ContextVarsSetupHook().run(ctx)
    # The hook keeps its own copy of the identity contextvars; assert on them
    # so a hook regression that publishes the route but not the session is
    # caught here rather than inside the tool.
    assert get_current_session_id() == ctx.session_id
    assert get_current_root_session_id() == ctx.root_session_id


def _text_of(chunk) -> str:
    return "".join(
        block.get("text", "") if isinstance(block, dict) else block.text
        for block in chunk.content
    )


async def _await_pending(svc: ApprovalService) -> str:
    for _ in range(200):
        if svc._pending:
            return next(iter(svc._pending))
        await asyncio.sleep(0.005)
    raise AssertionError("ask_user_question never created a pending record")


async def _await_push(channel: _RecordingChannel) -> dict:
    for _ in range(200):
        if channel.sent:
            return channel.sent[0]
        await asyncio.sleep(0.005)
    raise AssertionError("the question was never pushed to the channel")


async def test_console_turn_waits_and_returns_metadata(service):
    """A console turn needs no card push: the UI polls the pending record."""
    await _start_turn(
        _hook_context(
            AgentRequest(
                session_id="root-c",
                user_id="user-c",
                channel="console",
            ),
            session_id="root-c",
            agent_id="agent-c",
        ),
    )
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _await_pending(service)

    assert (
        service._pending[request_id].extra["questions"][0]["header"] == "Scope"
    )

    await service.resolve_request(
        request_id,
        ApprovalDecision.APPROVED,
        answer=json.dumps([{"selected": ["仅 auth"]}]),
    )
    chunk = await task

    assert chunk.state == ToolResultState.SUCCESS
    assert chunk.metadata["answers"] == [
        {
            "question": "要重构哪个范围？",
            "selected": ["仅 auth"],
            "other": None,
        },
    ]
    assert not service._pending


async def test_im_turn_pushes_the_card_to_its_own_session(service):
    """The channel instance a card is pushed with only ever lived in
    request_context; a plain tool reaches it through the route."""
    channel = _RecordingChannel()
    ctx = _hook_context(
        AgentRequest(
            session_id="root-i",
            user_id="user-i",
            channel="dingtalk",
            channel_instance=channel,
            channel_meta={"conversation_id": "conv-i"},
        ),
        session_id="root-i",
        agent_id="agent-i",
    )
    # What governance reads per tool call, straight from the same context.
    built = AgentBuilder._build_request_context(ctx)
    await _start_turn(ctx)
    route = get_current_approval_route() or {}
    assert route.get("_channel_instance") is built["_channel_instance"]
    assert get_current_channel() == "dingtalk"

    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _await_pending(service)
    pushed = await _await_push(channel)

    assert pushed["session_id"] == "root-i"
    assert pushed["request_id"] == request_id
    assert "1) 仅 auth" in pushed["result_summary"]

    # A real incoming command unblocks the waiting tool in this same turn.
    response = await _answer_command(
        request_id,
        "2",
        session_id="root-i",
        agent_id="agent-i",
        user_id="user-i",
    )
    assert "工具已批准" in response
    chunk = await asyncio.wait_for(task, 1)
    assert chunk.state == ToolResultState.SUCCESS
    assert chunk.metadata["answers"][0]["selected"] == ["auth + session"]


async def test_spawned_child_question_is_answered_from_the_parent(service):
    """A child has no chat of its own; its question has to reach the parent.

    This is the case that used to hang: the route carried neither
    ``_spawn_subagent`` nor ``root_agent_id``, so the pending record looked
    like a stranded child session, nothing was pushed, and the turn waited
    out the timeout.
    """
    parent_channel = _RecordingChannel()
    await _start_turn(
        _hook_context(
            AgentRequest(
                session_id="root-s",
                user_id="user-s",
                channel="feishu",
                channel_instance=parent_channel,
                channel_meta={"chat_id": "chat-s"},
            ),
            session_id="root-s",
            agent_id="agent-s",
        ),
    )

    # The same helper spawn_subagent uses to describe the child to itself.
    child_context = _build_spawn_request_context("agent-s")
    assert child_context["_spawn_subagent"] is True
    assert child_context["root_session_id"] == "root-s"

    await _start_turn(
        _hook_context(
            AgentRequest(
                session_id="child-s",
                user_id="user-s",
                channel="feishu",
                request_context=child_context,
            ),
            session_id="child-s",
            agent_id="agent-s",
            root_session_id="root-s",
        ),
    )
    route = get_current_approval_route() or {}
    assert route.get("_spawn_subagent") is True
    assert route.get("root_agent_id") == "agent-s"

    manager = _RecordingChannelManager(parent_channel)
    service.set_channel_manager(manager, "agent-s")

    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _await_pending(service)
    pending = service._pending[request_id]

    assert pending.session_id == "child-s"
    assert pending.root_session_id == "root-s"
    assert _is_spawn_child_approval(pending) is True
    # The parent's console view lists its children's questions.
    visible = await service.get_pending_by_root_session("root-s")
    assert [item.request_id for item in visible] == [request_id]

    pushed = await _await_push(parent_channel)
    assert manager.looked_up
    assert set(manager.looked_up) == {"feishu"}
    # Delivered to the root session, not to the child nobody renders.
    assert pushed["session_id"] == "root-s"

    response = await _answer_command(
        request_id,
        "仅 auth",
        session_id="root-s",
        agent_id="agent-s",
        user_id="user-s",
    )
    assert "工具已批准" in response
    chunk = await asyncio.wait_for(task, 1)

    assert chunk.state == ToolResultState.SUCCESS
    assert chunk.metadata["answers"][0]["other"] == "仅 auth"
    assert not service._pending


async def test_cron_turn_exits_before_waiting(service):
    """A scheduled turn looks like a console session but has nobody there."""
    await _start_turn(
        _hook_context(
            AgentRequest(
                session_id="root-x",
                user_id="cron",
                channel="console",
                request_context={"source": "cron", "cron_job_id": "job-1"},
            ),
            session_id="root-x",
            agent_id="agent-x",
        ),
    )
    chunk = await mod.ask_user_question(QUESTIONS)

    assert chunk.state == ToolResultState.ERROR
    assert "unattended flow" in _text_of(chunk)
    assert chunk.metadata == {}
    assert not service._pending


@pytest.mark.parametrize(
    "source",
    ["cron", "heartbeat", "mail_monitor", "headless"],
)
async def test_unattended_origin_survives_nested_spawn(source, service):
    """Starting workers cannot turn an unattended task into a live chat."""
    request_context = (
        {"_headless_tool_guard": "false"}
        if source == "headless"
        else {"source": source}
    )
    await _start_turn(
        _hook_context(
            AgentRequest(
                session_id="scheduled-root",
                user_id="scheduler",
                channel="console",
                request_context=request_context,
            ),
            session_id="scheduled-root",
            agent_id="scheduled-agent",
        ),
    )
    for session_id in ("scheduled-child", "scheduled-grandchild"):
        child_context = _build_spawn_request_context("scheduled-agent")
        assert child_context["source"] == source
        await _start_turn(
            _hook_context(
                AgentRequest(
                    session_id=session_id,
                    user_id="scheduler",
                    channel="console",
                    request_context=child_context,
                ),
                session_id=session_id,
                agent_id="scheduled-agent",
                root_session_id="scheduled-root",
            ),
        )
    assert get_current_approval_route()["source"] == source
    chunk = await asyncio.wait_for(mod.ask_user_question(QUESTIONS), 1)
    assert chunk.state == ToolResultState.ERROR
    assert not service._pending


@pytest.mark.parametrize("spawn_child", [False, True])
async def test_cross_configured_agent_exits_before_waiting(
    service,
    spawn_child,
):
    """A parent agent's root ID is not a remote question/answer bridge."""
    await _start_turn(
        _hook_context(
            AgentRequest(
                session_id="target-session",
                user_id="parent-agent",
                channel="console",
                request_context={"root_agent_id": "parent-agent"},
            ),
            session_id="target-session",
            agent_id="target-agent",
            root_session_id="parent-root",
            root_agent_id="parent-agent",
        ),
    )
    if spawn_child:
        child_context = _build_spawn_request_context("target-agent")
        assert child_context["root_agent_id"] == "parent-agent"
        await _start_turn(
            _hook_context(
                AgentRequest(
                    session_id="target-child",
                    user_id="parent-agent",
                    channel="console",
                    request_context=child_context,
                ),
                session_id="target-child",
                agent_id="target-agent",
                root_session_id="parent-root",
                root_agent_id="parent-agent",
            ),
        )
    chunk = await asyncio.wait_for(mod.ask_user_question(QUESTIONS), 1)
    assert chunk.state == ToolResultState.ERROR
    assert not service._pending


async def test_request_level_tool_call_id_is_not_a_turn_identity(service):
    """Replays use tool-call context, not a client request field."""
    await _start_turn(
        _hook_context(
            AgentRequest(
                session_id="root-replay",
                user_id="user",
                channel="console",
                request_context={"tool_call_id": "spoofed-call"},
            ),
            session_id="root-replay",
            agent_id="agent",
        ),
    )
    assert "tool_call_id" not in get_current_approval_route()
    task = asyncio.create_task(mod.ask_user_question(QUESTIONS))
    request_id = await _await_pending(service)
    assert service._pending[request_id].extra["tool_call"]["id"] == ""
    await _answer_command(
        request_id,
        "1",
        session_id="root-replay",
        agent_id="agent",
        user_id="user",
    )
    assert (await asyncio.wait_for(task, 1)).state == ToolResultState.SUCCESS


async def test_middleware_supplies_real_call_identity_and_keeps_metadata(
    service,
):
    """Production middleware binds the ID before the tool starts waiting."""
    context = _hook_context(
        AgentRequest(
            session_id="root-middleware",
            user_id="user",
            channel="console",
            request_context={"tool_call_id": "untrusted-request-id"},
        ),
        session_id="root-middleware",
        agent_id="agent",
    )
    await _start_turn(context)
    agent = SimpleNamespace(
        _request_context=AgentBuilder._build_request_context(context),
    )
    tool_call = SimpleNamespace(
        id="actual-ask-call",
        name="ask_user_question",
        input={"questions": json.loads(QUESTIONS)},
    )
    coordinator = ToolCoordinator()
    middleware = ToolCoordinatorMiddleware(coordinator)

    async def execute_tool(*, tool_call):
        yield await mod.ask_user_question(tool_call.input["questions"])

    async def collect():
        return [
            item
            async for item in middleware.on_acting(
                agent,
                {"tool_call": tool_call},
                execute_tool,
            )
        ]

    task = asyncio.create_task(collect())
    try:
        request_id = await _await_pending(service)
        pending = service._pending[request_id]
        assert pending.extra["tool_call"]["id"] == "actual-ask-call"
        await _answer_command(
            request_id,
            "1",
            session_id="root-middleware",
            agent_id="agent",
            user_id="user",
        )
        await asyncio.wait_for(task, 1)
        result = coordinator.get(tool_call.id).final_response
        assert result.state == ToolResultState.SUCCESS
        assert result.metadata["answers"][0]["selected"] == ["仅 auth"]
        assert not service._pending
    finally:
        await coordinator.shutdown()


@pytest.mark.parametrize("prefix", ["/approve", "/approval approve"])
async def test_im_multiquestion_json_survives_dispatch(prefix, service):
    """IM supports mixed selections/free text without altering JSON strings."""
    await _start_turn(
        _hook_context(
            AgentRequest(
                session_id="root-multi",
                user_id="user",
                channel="dingtalk",
                channel_instance=_RecordingChannel(),
            ),
            session_id="root-multi",
            agent_id="agent",
        ),
    )
    questions = json.loads(QUESTIONS)
    questions.append(
        {
            "question": "Which surfaces?",
            "header": "Surfaces",
            "multi_select": True,
            "options": [
                {"label": "console", "description": "web"},
                {"label": "desktop", "description": "native"},
            ],
        },
    )
    task = asyncio.create_task(mod.ask_user_question(questions))
    request_id = await _await_pending(service)
    raw_answer = json.dumps(
        [
            {"selected": [], "other": "-avoid  rewriting --pattern"},
            {"selected": ["console", "desktop"]},
        ],
        indent=2,
    )
    response = await _answer_command(
        request_id,
        raw_answer,
        session_id="root-multi",
        agent_id="agent",
        user_id="user",
        prefix=prefix,
    )
    assert "工具已批准" in response
    chunk = await asyncio.wait_for(task, 1)
    assert chunk.state == ToolResultState.SUCCESS
    assert chunk.metadata["answers"][0]["other"] == (
        "-avoid  rewriting --pattern"
    )
    assert chunk.metadata["answers"][1]["selected"] == ["console", "desktop"]
    assert not service._pending


async def test_spawned_im_without_registered_channel_exits_before_waiting(
    service,
):
    """A spawn marker alone cannot promise the parent will receive a card."""
    await _start_turn(
        _hook_context(
            AgentRequest(
                session_id="root-offline",
                user_id="user",
                channel="feishu",
                channel_instance=_RecordingChannel(),
            ),
            session_id="root-offline",
            agent_id="agent",
        ),
    )
    child_context = _build_spawn_request_context("agent")
    await _start_turn(
        _hook_context(
            AgentRequest(
                session_id="child-offline",
                user_id="user",
                channel="feishu",
                request_context=child_context,
            ),
            session_id="child-offline",
            agent_id="agent",
            root_session_id="root-offline",
        ),
    )
    chunk = await asyncio.wait_for(mod.ask_user_question(QUESTIONS), 1)
    assert chunk.state == ToolResultState.ERROR
    assert not service._pending

# -*- coding: utf-8 -*-
"""Conversation model types persist and inherit independently."""

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from qwenpaw.app.chats.api import get_chat_model, set_chat_model
from qwenpaw.app.chats.manager import ChatManager
from qwenpaw.app.chats.models import ChatSpec
from qwenpaw.app.chats.repo import JsonChatRepository
from qwenpaw.app.routers.console import _persist_pending_model_settings
from qwenpaw.config.config import AgentProfileConfig, ModelSlotConfig
from qwenpaw.services.session_models import decision_model_view, session_model
from qwenpaw.services.session_thinking import apply_session_thinking


@pytest.fixture
def environment(tmp_path):
    config = AgentProfileConfig(
        id="agent",
        name="Agent",
        active_model=ModelSlotConfig(provider_id="p", model="chat"),
    )
    global_model = ModelSlotConfig(provider_id="p", model="global-decision")
    provider = SimpleNamespace(
        enabled=True,
        get_model_info=lambda model: SimpleNamespace(
            name=model,
            model_type="chat" if model == "chat" else "decision",
            availability_status=None,
        ),
    )
    providers = SimpleNamespace(
        get_default_model=lambda kind, agent: agent.decision_model
        or global_model,
        get_provider=lambda provider_id: provider
        if provider_id == "p"
        else None,
    )
    workspace = SimpleNamespace(
        agent_id="agent",
        chat_manager=ChatManager(
            repo=JsonChatRepository(tmp_path / "chats.json")
        ),
    )
    with (
        patch(
            "qwenpaw.services.session_models.load_agent_config",
            return_value=config,
        ),
        patch(
            "qwenpaw.services.session_models.ProviderManager.get_instance",
            return_value=providers,
        ),
    ):
        yield workspace, config, provider


@pytest.mark.asyncio
async def test_inheritance_and_session_reset_are_independent(environment):
    workspace, config, _ = environment
    mgr = workspace.chat_manager
    first = await mgr.create_chat(ChatSpec(session_id="one", user_id="u"))
    second = await mgr.create_chat(ChatSpec(session_id="two", user_id="u"))
    selected = ModelSlotConfig(provider_id="p", model="selected")
    assert (await decision_model_view(workspace))["model"] == "global-decision"
    config.decision_model = ModelSlotConfig(
        provider_id="p", model="agent-decision"
    )
    view = await get_chat_model(first.id, "decision", mgr, workspace)
    assert (view["model"], view["model_source"]) == ("agent-decision", "agent")
    await mgr.set_session_model(first.id, config.active_model.model_dump())
    before = (await mgr.get_chat(first.id)).meta
    view = await set_chat_model(first.id, selected, mgr, workspace, "decision")
    assert (view["model"], view["model_source"]) == ("selected", "session")
    assert (await get_chat_model(second.id, "decision", mgr, workspace))[
        "model"
    ] == "agent-decision"
    reloaded = ChatManager(repo=mgr._repo)
    assert (
        session_model((await reloaded.get_chat(first.id)).meta, "decision")
        == selected
    )
    await set_chat_model(first.id, None, mgr, workspace, "decision")
    assert (await mgr.get_chat(first.id)).meta == before
    assert config.decision_model.model == "agent-decision"


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["chat", "missing-provider", "disabled"])
async def test_invalid_decision_selection_never_persists(environment, invalid):
    workspace, _, provider = environment
    mgr = workspace.chat_manager
    chat = await mgr.create_chat(ChatSpec(session_id="one", user_id="u"))
    provider.enabled = invalid != "disabled"
    selected = ModelSlotConfig(
        provider_id="missing" if invalid == "missing-provider" else "p",
        model="chat" if invalid == "chat" else "decision",
    )
    with pytest.raises(HTTPException) as exc:
        await set_chat_model(chat.id, selected, mgr, workspace, "decision")
    assert exc.value.status_code == 422
    assert (await mgr.get_chat(chat.id)).meta == chat.meta


@pytest.mark.asyncio
async def test_first_send_and_runtime_keep_decision_separate(environment):
    workspace, config, _ = environment
    mgr = workspace.chat_manager
    chat = await mgr.create_chat(
        ChatSpec(session_id="one", user_id="u", channel="console")
    )
    selected = {"provider_id": "p", "model": "selected"}
    request_context = {"session_decision_model": selected, "other": True}
    chat = await _persist_pending_model_settings(
        workspace, chat, request_context
    )
    assert request_context == {"other": True}
    assert session_model(chat.meta, "decision").model_dump() == selected
    ctx = SimpleNamespace(
        workspace=workspace,
        session_id="one",
        request=SimpleNamespace(channel="console", user_id="u"),
    )
    snapshot = await apply_session_thinking(ctx, config)
    assert snapshot.decision_model.model_dump() == selected
    assert snapshot.active_model == config.active_model
    assert config.decision_model is None
    chat = await _persist_pending_model_settings(
        workspace,
        chat,
        {
            "session_decision_model": {
                "provider_id": "p",
                "model": "replacement",
            },
        },
    )
    assert session_model(chat.meta, "decision").model_dump() == selected
    await mgr.set_session_model(chat.id, None)
    assert (
        session_model(
            (await mgr.get_chat(chat.id)).meta, "decision"
        ).model_dump()
        == selected
    )


@pytest.mark.asyncio
async def test_first_send_rejects_chat_model_in_decision_slot(environment):
    workspace, _, _ = environment
    mgr = workspace.chat_manager
    chat = await mgr.create_chat(ChatSpec(session_id="one", user_id="u"))
    with pytest.raises(HTTPException):
        await _persist_pending_model_settings(
            workspace,
            chat,
            {
                "session_decision_model": {
                    "provider_id": "p",
                    "model": "chat",
                },
            },
        )
    assert (
        session_model((await mgr.get_chat(chat.id)).meta, "decision") is None
    )

# -*- coding: utf-8 -*-
"""Decision preferences persist per conversation without executing a model."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from qwenpaw.app.chats import api
from qwenpaw.app.chats.manager import ChatManager
from qwenpaw.app.chats.models import ChatSpec
from qwenpaw.app.chats.repo import JsonChatRepository
from qwenpaw.app.routers.console import _persist_pending_model_settings
from qwenpaw.config.config import AgentProfileConfig
from qwenpaw.services.session_thinking import apply_session_thinking
from qwenpaw.providers.provider_manager import ProviderManager


@pytest.fixture
def provider_manager(monkeypatch):
    manager = SimpleNamespace(get_default_model=Mock(return_value=None))
    monkeypatch.setattr(ProviderManager, "get_instance", lambda: manager)
    return manager


@pytest.fixture
def agent_configs(monkeypatch, provider_manager):
    from qwenpaw.config import config as config_module

    configs = {
        "a": AgentProfileConfig(
            id="a",
            name="Agent A",
            decision_model={"provider_id": "typesafe", "model": "jev-latest"},
        ),
        "b": AgentProfileConfig(id="b", name="Agent B"),
    }
    monkeypatch.setattr(
        config_module, "load_agent_config", configs.__getitem__
    )
    return configs


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_selected", [False, True])
@pytest.mark.parametrize("global_selected", [False, True])
@pytest.mark.parametrize("override", [None, False, True])
async def test_default_and_model_availability_are_independent(
    agent_configs, provider_manager, agent_selected, global_selected, override
):
    selected = agent_configs["a"].decision_model
    if not agent_selected:
        agent_configs["a"].decision_model = None
    provider_manager.get_default_model.return_value = (
        selected if global_selected else None
    )
    view = await api._decision_settings(
        SimpleNamespace(agent_id="a"), override
    )
    assert view == {
        "configured": agent_selected or global_selected,
        "enabled": (agent_selected or global_selected)
        and (agent_selected if override is None else override),
        "override": override,
    }
    if agent_selected:
        provider_manager.get_default_model.assert_not_called()
    else:
        provider_manager.get_default_model.assert_called_once_with("decision")


@pytest.mark.asyncio
async def test_persistence_isolation_and_first_send_do_not_change_runtime(
    tmp_path,
    agent_configs,
):
    manager = ChatManager(repo=JsonChatRepository(tmp_path / "chats.json"))
    first = await manager.create_chat(
        ChatSpec(session_id="one", user_id="u", channel="console")
    )
    other = await manager.create_chat(ChatSpec(session_id="two", user_id="u"))
    workspace = SimpleNamespace(chat_manager=manager, agent_id="a")
    selected = {"provider_id": "p", "model": "chat"}
    await manager.set_session_model(first.id, selected)
    await api.set_decision_settings(first.id, True, manager, workspace)
    reloaded = ChatManager(repo=manager._repo)
    first = await reloaded.get_chat(first.id)
    assert first.meta["runtime_context"] == {
        "model": selected,
        "decision_enabled": True,
    }
    assert (await reloaded.get_chat(other.id)).meta == {}
    config = AgentProfileConfig(id="a", name="Agent", active_model=selected)
    ctx = SimpleNamespace(
        workspace=workspace,
        session_id="one",
        request=SimpleNamespace(channel="console", user_id="u"),
    )
    assert (
        await apply_session_thinking(ctx, config)
    ).model_dump() == config.model_dump()
    await api.set_decision_settings(first.id, False, manager, workspace)
    pending = {"session_decision_enabled": True, "other": 1}
    first = await _persist_pending_model_settings(workspace, first, pending)
    assert first.meta["runtime_context"]["decision_enabled"] is False
    assert pending == {"other": 1}
    pending = {"session_decision_enabled": False}
    other = await _persist_pending_model_settings(workspace, other, pending)
    assert other.meta["runtime_context"]["decision_enabled"] is False
    with pytest.raises(HTTPException) as invalid:
        await _persist_pending_model_settings(
            workspace, other, {"session_decision_enabled": "yes"}
        )
    assert invalid.value.status_code == 422
    # A model removed after draft selection must not block normal first send.
    agent_configs["a"].decision_model = None
    third = await manager.create_chat(
        ChatSpec(session_id="three", user_id="u")
    )
    third = await _persist_pending_model_settings(
        workspace, third, {"session_decision_enabled": True}
    )
    view = await api.get_decision_settings(third.id, None, manager, workspace)
    assert view == {"configured": False, "enabled": False, "override": True}
    await api.set_decision_settings(first.id, None, manager, workspace)
    runtime = (await manager.get_chat(first.id)).meta["runtime_context"]
    assert runtime == {"model": selected}


def test_settings_api_defaults_validation_and_missing_chat(
    tmp_path,
    agent_configs,
):
    manager = ChatManager(repo=JsonChatRepository(tmp_path / "chats.json"))
    workspace = SimpleNamespace(chat_manager=manager, agent_id="a")
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[api.get_chat_manager] = lambda: manager
    app.dependency_overrides[api.get_workspace] = lambda: workspace
    with TestClient(app) as client:
        assert client.get("/chats/decision-settings").json() == {
            "configured": True,
            "enabled": True,
            "override": None,
        }
        assert client.put("/chats/decision-settings", json=False).json() == {
            "configured": True,
            "enabled": False,
            "override": False,
        }
        chat = client.post(
            "/chats", json={"session_id": "s", "user_id": "u"}
        ).json()
        assert "decision_enabled" not in chat["meta"].get(
            "runtime_context", {}
        )
        url = f"/chats/{chat['id']}/decision-settings"
        assert client.put(url, json=True).status_code == 200
        assert client.get(
            "/chats/decision-settings", params={"chat_id": chat["id"]}
        ).json() == {"configured": True, "enabled": True, "override": True}
        assert client.put(url, json="true").status_code == 422
        assert (
            client.put(
                "/chats/missing/decision-settings", json=True
            ).status_code
            == 404
        )
        assert (
            client.get("/chats/decision-settings?chat_id=missing").status_code
            == 404
        )
        assert client.put(url, json=None).json() == {
            "configured": True,
            "enabled": True,
            "override": None,
        }


def test_inheritance_tracks_agent_changes_and_overrides_remain_local(
    tmp_path,
    agent_configs,
    provider_manager,
):
    manager = ChatManager(repo=JsonChatRepository(tmp_path / "chats.json"))
    workspace = SimpleNamespace(chat_manager=manager, agent_id="a")
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[api.get_chat_manager] = lambda: manager
    app.dependency_overrides[api.get_workspace] = lambda: workspace
    with TestClient(app) as client:
        first = client.post(
            "/chats", json={"session_id": "one", "user_id": "u"}
        ).json()
        second = client.post(
            "/chats", json={"session_id": "two", "user_id": "u"}
        ).json()
        url = f"/chats/{first['id']}/decision-settings"
        assert client.put(url, json=False).json()["enabled"] is False
        assert (
            client.get(
                "/chats/decision-settings", params={"chat_id": second["id"]}
            ).json()["enabled"]
            is True
        )
        selected = agent_configs["a"].decision_model
        agent_configs["a"].decision_model = None
        assert client.get(
            "/chats/decision-settings", params={"chat_id": second["id"]}
        ).json() == {
            "configured": False,
            "enabled": False,
            "override": None,
        }
        assert client.put(url, json=True).status_code == 422
        assert (
            client.put("/chats/decision-settings", json=True).status_code
            == 422
        )
        assert (
            client.get(
                "/chats/decision-settings", params={"chat_id": first["id"]}
            ).json()["override"]
            is False
        )
        agent_configs["a"].decision_model = selected
        assert (
            client.get(
                "/chats/decision-settings", params={"chat_id": first["id"]}
            ).json()["enabled"]
            is False
        )
        assert (
            client.get(
                "/chats/decision-settings", params={"chat_id": second["id"]}
            ).json()["enabled"]
            is True
        )
        assert client.put(url, json=None).json()["enabled"] is True
        workspace.agent_id = "b"
        assert client.get("/chats/decision-settings").json() == {
            "configured": False,
            "enabled": False,
            "override": None,
        }
        workspace.agent_id = "a"
        agent_configs["a"].decision_model = None
        provider_manager.get_default_model.return_value = selected
        assert client.get("/chats/decision-settings").json() == {
            "configured": True,
            "enabled": False,
            "override": None,
        }
        assert client.put(url, json=True).json() == {
            "configured": True,
            "enabled": True,
            "override": True,
        }
        assert (
            client.get(
                "/chats/decision-settings", params={"chat_id": first["id"]}
            ).json()["enabled"]
            is True
        )
        assert (
            client.get(
                "/chats/decision-settings", params={"chat_id": second["id"]}
            ).json()["enabled"]
            is False
        )
        assert agent_configs["a"].decision_model is None
        assert client.put(url, json=None).json() == {
            "configured": True,
            "enabled": False,
            "override": None,
        }
        provider_manager.get_default_model.return_value = None
        assert client.put(url, json=True).status_code == 422

# -*- coding: utf-8 -*-
"""TypeSafe connectivity and decision model configuration."""
# pylint: disable=redefined-outer-name,protected-access

import json
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from qwenpaw.exceptions import ProviderError
from qwenpaw.providers.model_info import ModelInfo
from qwenpaw.providers.model_sync import reconcile_models
from qwenpaw.providers.openai_provider import OpenAIProvider
from qwenpaw.providers.provider_manager import ProviderManager


@pytest.fixture
def manager(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "qwenpaw.providers.provider_manager.SECRET_DIR", tmp_path / "secrets"
    )
    result = ProviderManager()
    result.custom_providers["mixed"] = OpenAIProvider(
        id="mixed",
        name="Mixed",
        is_custom=True,
        api_key="test-key",
        base_url="https://example.test/v1",
        models=[ModelInfo(id="chat", name="Chat")],
    )
    return result


@pytest.fixture
def wire(monkeypatch):
    original = httpx.AsyncClient

    def install(handler):
        clients = []

        def client(**kwargs):
            result = original(
                transport=httpx.MockTransport(handler),
                **kwargs,
            )
            clients.append(result)
            return result

        monkeypatch.setattr(httpx, "AsyncClient", client)
        return clients

    return install


def test_typesafe_configuration_and_connection_api(manager, wire):
    from qwenpaw.app.routers import providers as routes

    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"models": [{"name": "jev-latest"}]})

    clients = wire(handler)
    manager.get_provider("typesafe").api_key = "test-key"
    app = FastAPI()
    app.state.provider_manager = manager
    app.include_router(routes.router)
    with TestClient(app) as client:
        result = client.post(
            "/models/typesafe/models",
            json={
                "id": "jev-latest",
                "name": "JEV",
                "model_type": "decision",
            },
        )
        assert result.status_code == 201
        result = client.post(
            "/models/typesafe/models/test", json={"model_id": "jev-latest"}
        )
        assert result.status_code == 200
        assert result.json()["success"]
        assert result.json()["verification"] == "live"
    request = requests[-1]
    assert request.url.path == "/v1/systemone"
    assert request.headers["authorization"] == "Bearer test-key"
    assert json.loads(request.content)["model"] == "jev-latest"
    assert (
        json.loads(request.content)["questions"]["greeting"]["type"] == "noul"
    )
    assert all(client.is_closed for client in clients)


async def test_typesafe_discovery(manager, wire):
    wire(lambda _: httpx.Response(200, json={"models": [{"name": "jev-new"}]}))
    provider = manager.get_provider("typesafe")
    assert (await provider.check_connection())[0]
    cards = await provider.fetch_models()
    assert [(m.id, m.model_type) for m in cards] == [("jev-new", "decision")]
    with pytest.raises(ProviderError, match="no chat model adapter"):
        provider.get_chat_model_instance("jev-new")


@pytest.mark.parametrize("status", [401, 429, 500])
async def test_typesafe_connection_failure(manager, wire, status):
    wire(lambda _: httpx.Response(status))
    provider = manager.get_provider("typesafe")
    assert not (await provider.check_connection())[0]
    result = await provider.check_model_connection("jev-latest")
    assert not result.success
    assert result.http_status == status


@pytest.mark.parametrize("provider_id", ["mixed", "dashscope"])
async def test_model_type_lifecycle(manager, provider_id, monkeypatch):
    await manager.add_model_to_provider(
        provider_id,
        ModelInfo(
            id="decision",
            name="Decision",
            model_type="decision",
            config_overrides=["model_type"],
        ),
    )
    provider = ProviderManager().get_provider(provider_id)
    assert provider.get_model_info("decision").model_type == "decision"
    assert any(m.model_type == "chat" for m in provider.models)
    cards = reconcile_models(
        provider, [ModelInfo(id="decision", name="Remote")], {"decision"}
    )
    assert cards[0].model_type == "decision"

    await manager.update_model_config(
        provider_id, "decision", {"model_type": "chat"}
    )
    assert (
        ProviderManager()
        .get_provider(provider_id)
        .get_model_info("decision")
        .model_type
        == "chat"
    )
    await manager.update_model_config(
        provider_id, "decision", {"model_type": "decision"}
    )
    with pytest.raises(ProviderError, match="already exists"):
        await manager.add_model_to_provider(
            provider_id, ModelInfo(id="decision", name="Chat")
        )
    with pytest.raises(ProviderError, match="not a chat model"):
        await manager.activate_model(provider_id, "decision")

    check = AsyncMock(return_value=(True, "connected"))
    monkeypatch.setattr(type(provider), "check_connection", check)
    result = await provider.check_model_connection("decision")
    assert result.success and result.verification == "provider_only"
    check.assert_awaited_once_with(timeout=5)

    await manager.delete_model_from_provider(provider_id, "decision")
    await manager.add_model_to_provider(
        provider_id, ModelInfo(id="decision", name="Chat")
    )
    assert (
        manager.get_provider(provider_id).get_model_info("decision").model_type
        == "chat"
    )


async def test_runtime_rejects_decision_model(manager, monkeypatch):
    from qwenpaw.agents import model_factory
    from qwenpaw.config.config import ModelSlotConfig

    await manager.add_model_to_provider(
        "mixed",
        ModelInfo(
            id="decision",
            name="Decision",
            model_type="decision",
        ),
    )
    monkeypatch.setattr(ProviderManager, "get_instance", lambda: manager)
    monkeypatch.setattr(
        model_factory,
        "_load_agent_model_settings",
        lambda *_args, **_kwargs: model_factory._AgentModelSettings(),
    )
    with pytest.raises(ProviderError, match="not a chat model"):
        model_factory.create_model_and_formatter(
            agent_id="default",
            model_slot_override=ModelSlotConfig(
                provider_id="mixed", model="decision"
            ),
        )


@pytest.mark.parametrize(
    "provider_id,model_id,automatic,override",
    [
        ("typesafe", "jev-latest", "decision", "chat"),
        ("dashscope", "qwen-max", "chat", "decision"),
    ],
)
async def test_model_type_override_survives_sync(
    manager, monkeypatch, provider_id, model_id, automatic, override
):
    provider = manager.get_provider(provider_id)
    monkeypatch.setattr(
        type(provider),
        "fetch_models",
        AsyncMock(
            return_value=[
                ModelInfo(id=model_id, name=model_id, model_type=automatic)
            ]
        ),
    )
    await manager.update_model_config(
        provider_id, model_id, {"model_type": override}
    )
    await manager.discover_provider_models(provider_id)
    restored = ProviderManager().get_provider(provider_id)
    model = restored.get_model_info(
        model_id
    ) or restored.get_discovered_model_info(model_id)
    assert model.model_type == override
    assert "model_type" in model.config_overrides
    assert (
        next(
            m for m in restored.discovery_candidates() if m.id == model_id
        ).model_type
        == override
    )


def test_model_type_config_api(manager):
    from qwenpaw.app.routers import providers as routes

    app = FastAPI()
    app.state.provider_manager = manager
    app.include_router(routes.router)
    with TestClient(app) as client:
        path = "/models/typesafe/models/jev-latest/config"
        assert (
            client.put(path, json={"model_type": "invalid"}).status_code == 422
        )
        assert client.put(path, json={"model_type": "chat"}).status_code == 200
        assert (
            manager.get_provider("typesafe")
            .get_model_info("jev-latest")
            .model_type
            == "chat"
        )
        assert client.put(path, json={"model_type": None}).status_code == 422
        assert (
            client.put(path, json={"model_type": "decision"}).status_code
            == 200
        )
        assert (
            manager.get_provider("typesafe")
            .get_model_info("jev-latest")
            .model_type
            == "decision"
        )


async def test_automatic_type_follows_discovery(manager, monkeypatch):
    provider = manager.get_provider("typesafe")
    monkeypatch.setattr(
        type(provider),
        "fetch_models",
        AsyncMock(return_value=[ModelInfo(id="jev-latest", name="JEV")]),
    )
    await manager.discover_provider_models("typesafe")
    model = (
        ProviderManager().get_provider("typesafe").get_model_info("jev-latest")
    )
    assert model.model_type == "chat"


@pytest.mark.parametrize(
    "provider_id,model_id", [("typesafe", "jev-latest"), ("mixed", "decision")]
)
async def test_global_defaults_are_independent_and_persist(
    manager, monkeypatch, provider_id, model_id
):
    from qwenpaw.config.config import ModelSlotConfig
    from qwenpaw.app.routers import providers as routes

    monkeypatch.setattr(manager, "maybe_probe_multimodal", lambda *_: None)
    await manager.add_model_to_provider(
        "mixed",
        ModelInfo(id="decision", name="Decision", model_type="decision"),
    )
    chat = ModelSlotConfig(provider_id="mixed", model="chat")
    decision = ModelSlotConfig(provider_id=provider_id, model=model_id)
    app = FastAPI()
    app.state.provider_manager = manager
    app.include_router(routes.router)
    with TestClient(app) as client:
        assert (
            client.put(
                "/models/defaults/chat", json=chat.model_dump()
            ).status_code
            == 200
        )
        response = client.put(
            "/models/defaults/decision", json=decision.model_dump()
        )
        assert response.status_code == 200
        assert response.json()["default_models"] == {
            "chat": chat.model_dump(),
            "decision": decision.model_dump(),
        }
        assert response.json()["active_llm"] == chat.model_dump()
        restored = ProviderManager()
        assert restored.get_default_model("decision") == decision
        assert restored.get_active_model() == chat
        for model_type, wrong in [("decision", chat), ("chat", decision)]:
            assert (
                client.put(
                    f"/models/defaults/{model_type}", json=wrong.model_dump()
                ).status_code
                == 400
            )
        assert (
            client.put(
                "/models/defaults/image", json=chat.model_dump()
            ).status_code
            == 422
        )
        response = client.put("/models/defaults/decision", json=None)
        assert response.status_code == 200
        restored = ProviderManager()
        assert restored.get_default_model("decision") is None
        assert restored.get_active_model() == chat


@pytest.mark.parametrize(
    "change",
    [
        "type",
        "delete_model",
        "disable_provider",
        "delete_provider",
        "deselect",
        "deselect_all",
    ],
)
async def test_invalid_decision_default_is_cleared(manager, change):
    from qwenpaw.config.config import ModelSlotConfig

    await manager.add_model_to_provider(
        "mixed",
        ModelInfo(id="decision", name="Decision", model_type="decision"),
    )
    chat = manager.get_active_model()
    await manager.set_default_model(
        "decision", ModelSlotConfig(provider_id="mixed", model="decision")
    )
    if change == "type":
        await manager.update_model_config(
            "mixed", "decision", {"model_type": "chat"}
        )
    elif change == "delete_model":
        await manager.delete_model_from_provider("mixed", "decision")
    elif change == "disable_provider":
        await manager.update_provider_async("mixed", {"enabled": False})
    elif change == "delete_provider":
        await manager.remove_custom_provider_async("mixed")
    elif change == "deselect":
        await manager.update_model_pool("mixed", "decision", selected=False)
    else:
        await manager.select_all_models("mixed", selected=False)
    assert manager.get_default_model("decision") is None
    assert ProviderManager().get_default_model("decision") is None
    assert manager.get_active_model() == chat


async def test_decision_default_write_failure_preserves_previous_choice(
    manager, monkeypatch
):
    from qwenpaw.config.config import ModelSlotConfig

    slot = ModelSlotConfig(provider_id="typesafe", model="jev-latest")
    await manager.set_default_model("decision", slot)
    await manager.add_model_to_provider(
        "typesafe", ModelInfo(id="other", name="Other", model_type="decision")
    )
    replacement = ModelSlotConfig(provider_id="typesafe", model="other")

    def fail(*_):
        raise OSError("disk full")

    monkeypatch.setattr(manager, "save_active_model", fail)
    with pytest.raises(OSError, match="disk full"):
        await manager.set_default_model("decision", replacement)
    assert manager.get_default_model("decision") == slot
    assert ProviderManager().get_default_model("decision") == slot


def test_model_pool_filters_type_before_pagination():
    from qwenpaw.providers.model_pool import ModelPoolQuery, model_pool_page

    provider = OpenAIProvider(
        id="mixed",
        name="Mixed",
        models=[
            ModelInfo(id="chat", name="Chat"),
            ModelInfo(id="decision", name="Decision", model_type="decision"),
        ],
    )
    page = model_pool_page(
        provider, ModelPoolQuery(model_type="decision", limit=1)
    )
    assert page.total == 1
    assert [model.id for model in page.models] == ["decision"]


@pytest.fixture
def agent_model_client(manager, monkeypatch):
    from qwenpaw.app.routers import agents as routes
    from qwenpaw.config.config import AgentProfileConfig, ModelSlotConfig

    monkeypatch.setattr(manager, "maybe_probe_multimodal", lambda *_: None)
    provider = manager.get_provider("mixed")
    provider.models.append(
        ModelInfo(id="decision", name="Decision", model_type="decision")
    )
    chat = ModelSlotConfig(provider_id="mixed", model="chat")
    decision = ModelSlotConfig(provider_id="mixed", model="decision")
    manager.default_models.update(chat=chat, decision=decision)
    saved = {"config": AgentProfileConfig(id="bot", name="Bot")}

    def mutate(agent_id, callback):
        assert agent_id == "bot"
        candidate = saved["config"].model_copy(deep=True)
        callback(candidate)
        saved["config"] = candidate
        return candidate

    monkeypatch.setattr(routes, "mutate_agent_config", mutate)
    monkeypatch.setattr(routes, "schedule_agent_reload", lambda *_: None)
    app = FastAPI()
    app.state.provider_manager = manager
    app.include_router(routes.router)
    with TestClient(app) as client:
        yield client, saved, chat, decision


def test_agent_decision_choice_persists_without_inheriting_global(
    manager, agent_model_client
):
    from qwenpaw.config.config import AgentProfileConfig, ModelSlotConfig

    client, saved, chat, decision = agent_model_client
    assert manager.get_default_model("decision", saved["config"]) is None
    response = client.patch(
        "/agents/bot/model-settings",
        json={
            "active_model": chat.model_dump(),
            "decision_model": decision.model_dump(),
        },
    )
    assert response.status_code == 200
    restored = AgentProfileConfig.model_validate_json(
        saved["config"].model_dump_json()
    )
    assert restored.decision_model == decision
    assert manager.get_default_model("decision", restored) == decision
    assert manager.get_default_model("chat", restored) == chat
    assert manager.default_models == {"chat": chat, "decision": decision}
    next_global = ModelSlotConfig(provider_id="typesafe", model="jev-latest")
    manager.default_models["decision"] = next_global
    assert manager.get_default_model("decision", restored) == decision
    manager.default_models["decision"] = None
    assert manager.get_default_model("decision", restored) == decision
    manager.default_models["decision"] = decision
    response = client.patch(
        "/agents/bot/model-settings", json={"decision_model": None}
    )
    assert response.status_code == 200
    restored = AgentProfileConfig.model_validate_json(
        saved["config"].model_dump_json()
    )
    assert restored.decision_model is None
    assert manager.get_default_model("decision", restored) is None
    assert manager.get_default_model("chat", saved["config"]) == chat
    assert manager.get_default_model("decision") == decision


@pytest.mark.parametrize(
    ("value", "status"),
    [(True, 422), ("decision", 422), (1, 422), ({}, 404), ([], 422)],
)
def test_agent_decision_choice_rejects_invalid_slots_atomically(
    agent_model_client, value, status
):
    client, saved, _, _ = agent_model_client
    response = client.patch(
        "/agents/bot/model-settings",
        json={"decision_model": value, "thinking_level": "high"},
    )
    assert response.status_code == status
    assert saved["config"].decision_model is None
    assert saved["config"].thinking_level == "inherit"


def test_chat_fallback_changes_preserve_decision_choice(
    agent_model_client,
):
    client, saved, chat, decision = agent_model_client
    response = client.patch(
        "/agents/bot/model-settings",
        json={
            "fallback_models": [chat.model_dump()],
            "fallback_policy": {"enabled": True, "target_scope": "free_only"},
            "decision_model": decision.model_dump(),
        },
    )
    assert response.status_code == 200
    response = client.patch(
        "/agents/bot/model-settings",
        json={"fallback_models": [], "fallback_policy": {"enabled": False}},
    )
    assert response.status_code == 200
    assert saved["config"].decision_model == decision
    assert saved["config"].fallback_models == []
    assert not saved["config"].fallback_policy.enabled


@pytest.mark.parametrize(
    ("field", "model"),
    [
        ("active_model", "decision"),
        ("decision_model", "chat"),
        ("subagent_model", "decision"),
        ("fallback_models", "decision"),
    ],
)
def test_agent_model_settings_reject_wrong_type_atomically(
    agent_model_client, field, model
):
    client, saved, _, _ = agent_model_client
    slot = {"provider_id": "mixed", "model": model}
    response = client.patch(
        "/agents/bot/model-settings",
        json={
            field: [slot] if field.endswith("fallback_models") else slot,
            "thinking_level": "high",
        },
    )
    assert response.status_code == 400
    assert "model" in response.json()["detail"]
    assert saved["config"].thinking_level == "inherit"
    assert saved["config"].decision_model is None


def test_agent_decision_choice_can_differ_from_global(
    manager, agent_model_client
):
    from qwenpaw.config.config import AgentProfileConfig, ModelSlotConfig

    client, saved, chat, global_decision = agent_model_client
    override = ModelSlotConfig(provider_id="typesafe", model="jev-latest")
    response = client.patch(
        "/agents/bot/model-settings",
        json={
            "decision_model": override.model_dump(),
        },
    )
    assert response.status_code == 200
    restored = AgentProfileConfig.model_validate_json(
        saved["config"].model_dump_json()
    )
    assert restored.decision_model == override
    assert manager.get_default_model("decision", restored) == override
    assert manager.get_default_model("chat", restored) == chat
    assert manager.get_default_model("decision") == global_decision


def test_agent_decision_override_rejects_unknown_model_atomically(
    agent_model_client,
):
    client, saved, _, _ = agent_model_client
    response = client.patch(
        "/agents/bot/model-settings",
        json={
            "decision_model": {"provider_id": "typesafe", "model": "missing"},
            "thinking_level": "high",
        },
    )
    assert response.status_code == 400
    assert saved["config"].decision_model is None
    assert saved["config"].thinking_level == "inherit"

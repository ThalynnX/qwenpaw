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
        ),
    )
    provider = ProviderManager().get_provider(provider_id)
    assert provider.get_model_info("decision").model_type == "decision"
    assert any(m.model_type == "chat" for m in provider.models)
    cards = reconcile_models(
        provider, [ModelInfo(id="decision", name="Remote")], {"decision"}
    )
    assert cards[0].model_type == "decision"

    with pytest.raises(ProviderError, match="cannot be changed"):
        await manager.update_model_config(
            provider_id, "decision", {"model_type": "chat"}
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

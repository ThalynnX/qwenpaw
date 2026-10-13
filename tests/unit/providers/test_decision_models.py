# -*- coding: utf-8 -*-
"""Decision models share provider configuration but have typed execution."""
# pylint: disable=redefined-outer-name,protected-access

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from qwenpaw.exceptions import ProviderError
from qwenpaw.providers.model_info import ModelInfo
from qwenpaw.providers.openai_provider import OpenAIProvider
from qwenpaw.providers.provider import ModelConnectionResult
from qwenpaw.providers.provider_manager import ProviderManager
from qwenpaw.providers.systemone_model import (
    ChoiceQuestion,
    NoulQuestion,
    ScoreQuestion,
    SystemOneDecisionModel,
)
from qwenpaw.providers.typesafe_provider import TypeSafeProvider


def answers_for(payload):
    answers = {}
    for key, question in payload["questions"].items():
        kind = question["type"]
        if kind == "noul":
            answers[key] = {"type": kind, "noul": 0.7}
        elif kind == "choice":
            options = list(question["criteria"])
            answers[key] = {
                "type": kind,
                "choice": options[0],
                "probabilities": {
                    option: 1 / len(options) for option in options
                },
                "confidence": 0.1,
            }
        else:
            levels = question["criteria"]
            answers[key] = {
                "type": kind,
                "score": 0.5,
                "legend": {str(i): text for i, text in enumerate(levels)},
                "probabilities": {
                    str(i): 1 / len(levels) for i in range(len(levels))
                },
                "confidence": 0.1,
            }
    return {
        "model": "resolved-model",
        "answers": answers,
        "usage": {"input_tokens": 12},
        "request_id": "request-test",
        "latency_ms": 20,
    }


@pytest.fixture
def wire(monkeypatch):
    clients = []
    original = httpx.AsyncClient

    def install(handler):
        def client(**kwargs):
            instance = original(
                transport=httpx.MockTransport(handler),
                **kwargs,
            )
            clients.append(instance)
            return instance

        monkeypatch.setattr(httpx, "AsyncClient", client)
        return clients

    return install


@pytest.fixture
def manager(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "qwenpaw.providers.provider_manager.SECRET_DIR",
        tmp_path / "secrets",
    )
    result = ProviderManager()
    result.custom_providers["mixed"] = OpenAIProvider(
        id="mixed",
        name="Mixed",
        is_custom=True,
        api_key="test-provider-key",
        base_url="https://chat.example/v1",
        models=[
            ModelInfo(id="chat", name="Chat", source="user"),
            ModelInfo(
                id="decision",
                name="Decision",
                source="user",
                model_type="decision",
                base_url="https://decision.example/v1/",
            ),
        ],
    )
    return result


async def test_typed_call_uses_model_endpoint_and_closes_client(manager, wire):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            200,
            json=answers_for(json.loads(request.content)),
        )

    clients = wire(handler)
    async with manager.create_decision_model("mixed", "decision") as model:
        result = await model.evaluate(
            state={"request": "查找历史讨论"},
            questions={
                "tool": ChoiceQuestion(
                    instructions="Select a tool",
                    criteria={"memory": "History", "none": "No tool"},
                ),
                "relevant": NoulQuestion(instructions="Is it relevant?"),
                "score": ScoreQuestion(
                    instructions="Rate it",
                    criteria=["Low", "High"],
                ),
            },
        )
    assert str(requests[0].url) == "https://decision.example/v1/systemone"
    assert requests[0].headers["authorization"] == "Bearer test-provider-key"
    assert json.loads(requests[0].content)["model"] == "decision"
    assert result.answers["tool"].confidence == 0.1
    assert result.model == "resolved-model"
    assert result.usage.output_tokens is None
    assert clients[0].is_closed
    assert manager.get_provider("mixed").base_url == "https://chat.example/v1"


@pytest.mark.parametrize(
    "status,attempts",
    [(401, 1), (422, 1), (429, 2), (529, 2)],
)
async def test_http_failures_have_bounded_retries(status, attempts, wire):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, headers={"retry-after": "0"})

    wire(handler)
    async with SystemOneDecisionModel(
        model="test",
        base_url="https://test/v1",
        api_key="key",
    ) as model:
        with pytest.raises(ProviderError) as error:
            await model.evaluate(
                state="text",
                questions={"q": NoulQuestion(instructions="Is it true?")},
            )
    assert error.value.details["http_status"] == status
    assert len(requests) == attempts


@pytest.mark.parametrize(
    "change",
    ["missing", "type", "choice", "probability", "score"],
)
async def test_invalid_answers_are_rejected(change, wire):
    def handler(request):
        payload = answers_for(json.loads(request.content))
        if change == "missing":
            payload["answers"].pop("q")
        elif change == "type":
            payload["answers"]["q"] = {"type": "noul", "noul": 0.5}
        elif change == "choice":
            payload["answers"]["q"]["choice"] = "unknown"
        elif change == "probability":
            payload["answers"]["q"]["probabilities"]["a"] = 2
        else:
            payload["answers"]["score"]["score"] = 5
        return httpx.Response(200, json=payload)

    wire(handler)
    async with SystemOneDecisionModel(
        model="test",
        base_url="https://test/v1",
        api_key="key",
    ) as model:
        with pytest.raises(ProviderError) as error:
            await model.evaluate(
                state="text",
                questions={
                    "q": ChoiceQuestion(
                        instructions="Choose",
                        criteria={"a": "A", "b": "B"},
                    ),
                    "score": ScoreQuestion(
                        instructions="Rate",
                        criteria=["Low", "High"],
                    ),
                },
            )
    assert error.value.details["error_kind"] == "invalid_response"


async def test_timeout_and_cancellation_propagate(wire):
    async def handler(_request):
        await asyncio.sleep(10)
        return httpx.Response(200)

    clients = wire(handler)
    async with SystemOneDecisionModel(
        model="test",
        base_url="https://test/v1",
        api_key="key",
    ) as model:
        with pytest.raises(ProviderError) as error:
            await model.evaluate(
                state="text",
                questions={"q": NoulQuestion(instructions="True?")},
                timeout=0.01,
            )
        assert error.value.details["error_kind"] == "timeout"
        task = asyncio.create_task(
            model.evaluate(
                state="text",
                questions={"q": NoulQuestion(instructions="True?")},
            ),
        )
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert clients[0].is_closed


@pytest.mark.parametrize("removed", [False, True])
async def test_draft_test_does_not_save_overrides(manager, wire, removed):
    if removed:
        manager.get_provider("mixed").removed_model_ids.append("draft")
    captured = []

    def handler(request):
        captured.append(request)
        return httpx.Response(
            200,
            json=answers_for(json.loads(request.content)),
        )

    wire(handler)
    result = await manager.check_provider_model(
        "mixed",
        "draft",
        overrides={
            "model_type": "decision",
            "base_url": "https://draft.example/v1",
        },
    )
    assert result.success
    assert str(captured[0].url) == "https://draft.example/v1/systemone"
    assert manager.get_provider("mixed").get_model_info("draft") is None
    assert (
        "draft" in manager.get_provider("mixed").removed_model_ids
    ) == removed
    assert not (manager.custom_path / "mixed.json").exists()


async def test_mixed_provider_test_dispatch_and_chat_type_guard(
    manager,
    wire,
    monkeypatch,
):
    wire(
        lambda request: httpx.Response(
            200,
            json=answers_for(json.loads(request.content)),
        ),
    )
    seen = []

    async def chat_check(provider, model_id, timeout=5):
        assert timeout == 5
        seen.append((provider.base_url, model_id))
        return ModelConnectionResult(success=True)

    monkeypatch.setattr(OpenAIProvider, "check_model_connection", chat_check)
    assert (await manager.check_provider_model("mixed", "chat")).success
    assert (await manager.check_provider_model("mixed", "decision")).success
    assert seen == [("https://chat.example/v1", "chat")]
    with pytest.raises(ProviderError, match="not a chat"):
        await manager.activate_model("mixed", "decision")
    with pytest.raises(ProviderError, match="not a chat"):
        manager.create_chat_model("mixed", "decision")


async def test_restart_and_discovery_preserve_model_config(manager):
    await manager.update_model_config(
        "mixed",
        "decision",
        {"base_url": "https://override.example/v1"},
    )
    restored = ProviderManager()
    card = restored.get_provider("mixed").get_model_info("decision")
    assert card.model_type == "decision"
    assert card.base_url == "https://override.example/v1"
    from qwenpaw.providers.model_sync import reconcile_models

    cards = reconcile_models(
        restored.get_provider("mixed"),
        [ModelInfo(id="decision", name="Remote")],
        {"decision"},
    )
    assert cards[0].base_url == card.base_url
    assert cards[0].model_type == "decision"
    await restored.update_model_config("mixed", "decision", {"base_url": None})
    assert (
        ProviderManager()
        .get_provider("mixed")
        .get_model_info("decision")
        .base_url
        is None
    )


@pytest.mark.parametrize(
    "model_id,new_type", [("chat", "decision"), ("decision", "chat")]
)
async def test_existing_model_type_is_fixed(manager, model_id, new_type):
    original = (
        manager.get_provider("mixed").get_model_info(model_id).model_type
    )
    with pytest.raises(ProviderError, match="Model type cannot be changed"):
        await manager.update_model_config(
            "mixed", model_id, {"model_type": new_type}
        )
    with pytest.raises(ProviderError, match="Model type cannot be changed"):
        await manager.add_model_to_provider(
            "mixed", ModelInfo(id=model_id, name=model_id, model_type=new_type)
        )
    assert (
        manager.get_provider("mixed").get_model_info(model_id).model_type
        == original
    )


@pytest.mark.parametrize(
    "field", ["active_model", "subagent_model", "fallback_models"]
)
def test_create_agent_rejects_decision_in_any_chat_slot(manager, field):
    from qwenpaw.app.routers import agents as routes

    app = FastAPI()
    app.state.provider_manager = manager
    app.include_router(routes.router)
    slot = {"provider_id": "mixed", "model": "decision"}
    with TestClient(app) as client:
        response = client.post(
            "/agents",
            json={
                "name": "Test",
                field: [slot] if field == "fallback_models" else slot,
            },
        )
    assert response.status_code == 400
    assert "not a chat model" in response.json()["detail"]


def test_runtime_factory_rejects_decision_reference(manager, monkeypatch):
    from qwenpaw.agents import model_factory
    from qwenpaw.config.config import ModelSlotConfig

    monkeypatch.setattr(ProviderManager, "get_instance", lambda: manager)
    monkeypatch.setattr(
        model_factory,
        "_load_agent_model_settings",
        lambda *_args, **_kwargs: model_factory._AgentModelSettings(),
    )
    with pytest.raises(ProviderError, match="not a chat"):
        model_factory.create_model_and_formatter(
            agent_id="default",
            model_slot_override=ModelSlotConfig(
                provider_id="mixed", model="decision"
            ),
        )


async def test_typesafe_discovery_uses_native_models_payload(wire):
    wire(
        lambda _request: httpx.Response(
            200,
            json={
                "models": [{"name": "jev-latest", "description": "Decisions"}],
            },
        ),
    )
    provider = TypeSafeProvider(
        id="typesafe",
        name="TypeSafe",
        base_url="https://test/v1",
        api_key="test",
    )
    cards = await provider.fetch_models()
    assert cards[0].id == "jev-latest"
    assert cards[0].model_type == "decision"
    with pytest.raises(ProviderError):
        provider.get_chat_model_instance("jev-latest")


def test_api_add_draft_test_and_chat_slot_validation(manager, wire):
    from qwenpaw.app.routers import providers as routes

    wire(
        lambda request: httpx.Response(
            200,
            json=answers_for(json.loads(request.content)),
        ),
    )
    app = FastAPI()
    app.state.provider_manager = manager
    app.include_router(routes.router)
    with TestClient(app) as client:
        draft = {
            "model_id": "new-decision",
            "model_type": "decision",
            "base_url": "https://draft.example/v1",
        }
        assert client.post("/models/mixed/models/test", json=draft).json()[
            "success"
        ]
        assert (
            manager.get_provider("mixed").get_model_info("new-decision")
            is None
        )
        response = client.post(
            "/models/mixed/models",
            json={
                "id": draft["model_id"],
                "name": "Decision",
                "model_type": draft["model_type"],
                "base_url": draft["base_url"],
            },
        )
        assert response.status_code == 201
        model = manager.get_provider("mixed").get_model_info("new-decision")
        assert model.model_type == "decision"
        assert model.base_url == draft["base_url"]
        with pytest.raises(HTTPException) as error:
            routes._validate_model_slot(manager, "mixed", "new-decision")
        assert error.value.status_code == 400
        draft["base_url"] = "invalid endpoint"
        assert (
            client.post("/models/mixed/models/test", json=draft).status_code
            == 422
        )


async def test_builtin_metadata_and_model_endpoint_survive_restart(manager):
    assert (
        manager.get_provider("typesafe")
        .get_model_info("jev-latest")
        .model_type
        == "decision"
    )
    dashscope = manager.get_provider("dashscope")
    assert (
        dashscope.get_model_info("decision-model-preview").model_type
        == "decision"
    )
    await manager.update_model_config(
        "dashscope",
        "decision-model-preview",
        {
            "base_url": (
                "https://workspace.cn-beijing.maas.aliyuncs.com/"
                "compatible-mode/v1"
            ),
        },
    )
    restored = ProviderManager().get_provider("dashscope")
    assert restored.base_url == dashscope.base_url
    assert (
        restored.get_model_info("decision-model-preview").base_url
        == "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    )
    assert (
        restored.get_model_info("decision-model-preview").model_type
        == "decision"
    )
    assert (
        next(
            m
            for m in restored.discovery_candidates()
            if m.id == "decision-model-preview"
        ).model_type
        == "decision"
    )

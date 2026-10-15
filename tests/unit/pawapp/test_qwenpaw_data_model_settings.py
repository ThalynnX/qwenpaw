"""References stay scoped; only execution resolves provider credentials."""

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from qwenpaw.pawapp.tasks import TaskScope

path = (
    Path(__file__).resolve().parents[3]
    / "plugins/apps/qwenpaw-data/backend/model_settings.py"
)
spec = importlib.util.spec_from_file_location(
    "data_model_settings_under_test", path
)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


@pytest.fixture
def configured(tmp_path, monkeypatch):
    provider = SimpleNamespace(
        id="provider",
        name="Provider",
        api_key="private-test-key",
        base_url="https://models.example/v1",
        enabled=True,
        chat_model="OpenAIChatModel",
        models=[SimpleNamespace(id="model-a", name="Model A")],
        extra_models=[],
        discovered_models=[],
        get_model_info=lambda value: (
            object() if value in {"model-a", "model-b"} else None
        ),
    )
    manager = SimpleNamespace(
        get_provider=lambda _: provider,
        list_provider_info=AsyncMock(return_value=[provider]),
    )
    service = module.ModelSettingsService(tmp_path)
    monkeypatch.setattr(service, "_manager", lambda: manager)
    monkeypatch.setattr(
        service,
        "_workspace_choice",
        lambda scope: module.ModelChoice(
            source="host",
            provider_id="provider",
            model_id="model-a" if scope.workspace_id == "one" else "model-b",
        ),
    )
    return service, provider


def scope(workspace="one", principal="alice"):
    return TaskScope(
        app_id="qwenpaw-data", principal_id=principal, workspace_id=workspace
    )


@pytest.mark.asyncio
async def test_references_and_metadata_never_copy_keys(configured, tmp_path):
    service, provider = configured
    response = await service.save(
        scope(),
        module.ModelSettings(
            lightweight=module.ModelChoice(
                source="host", provider_id="provider", model_id="model-b"
            )
        ),
    )
    assert "private-test-key" not in json.dumps(response)
    assert "private-test-key" not in next(tmp_path.glob("*.json")).read_text()
    runtime = await service.runtime(scope())
    assert runtime["analysis"]["model_id"] == "model-a"
    assert runtime["lightweight"]["model_id"] == "model-b"
    assert runtime["databridge"]["model_id"] == "model-a"
    provider.api_key = "rotated-key"
    assert (await service.runtime(scope()))["analysis"][
        "api_key"
    ] == "rotated-key"
    assert runtime["analysis"]["api_key"] == "private-test-key"


@pytest.mark.asyncio
async def test_scope_isolation_and_stale_save(configured):
    service, _ = configured
    await service.save(
        scope(),
        module.ModelSettings(analysis=module.ModelChoice(source="local")),
    )
    assert service.load(scope()).analysis.source == "local"
    assert service.load(scope("two")).analysis.source == "inherit"
    assert service.load(scope(principal="bob")).analysis.source == "inherit"
    assert (await service.runtime(scope("two")))["analysis"][
        "model_id"
    ] == "model-b"
    with pytest.raises(HTTPException) as error:
        await service.save(scope(), module.ModelSettings())
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_unsupported_provider_fails_explicitly(configured):
    service, provider = configured
    provider.chat_model = "AnthropicChatModel"
    response = await service.describe(scope())
    assert not response["effective"]["analysis"]["configured"]
    with pytest.raises(ValueError):
        await service.runtime(scope())

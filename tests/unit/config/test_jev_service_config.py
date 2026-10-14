# -*- coding: utf-8 -*-
"""Global Jev connection settings are separate from model providers."""

import pytest
from pydantic import ValidationError

from qwenpaw.config.config import Config, JevServiceConfig


def test_default_service_endpoint():
    assert Config().jev_service.base_url == "https://api.typesafe.ai"


@pytest.mark.parametrize(
    "base_url",
    [
        "http://remote.example",
        "https://user:pass@example.com",
        "https://example.com/path",
        "https://example.com?key=secret",
        "file:///tmp/jev",
    ],
)
def test_rejects_unsafe_or_ambiguous_base_url(base_url):
    with pytest.raises(ValidationError):
        JevServiceConfig(base_url=base_url)


def test_accepts_https_and_local_http():
    assert JevServiceConfig(base_url="https://proxy.example/").base_url == (
        "https://proxy.example"
    )
    assert JevServiceConfig(base_url="http://localhost:8000").base_url == (
        "http://localhost:8000"
    )


@pytest.mark.asyncio
async def test_global_endpoint_does_not_return_secret(monkeypatch):
    import qwenpaw.app.routers.config as route
    import qwenpaw.services.jev as service

    config = Config()
    stored_keys = []

    async def run_sync(func, *args):
        return func(*args)

    def mutate(update):
        update(config)
        return config

    async def set_key(key):
        stored_keys.append(key)

    async def get_key():
        return stored_keys[-1] if stored_keys else None

    monkeypatch.setattr(route, "run_sync_io", run_sync)
    monkeypatch.setattr(route, "load_config", lambda: config)
    monkeypatch.setattr(route, "mutate_config", mutate)
    monkeypatch.setattr(service, "set_api_key", set_key)
    monkeypatch.setattr(service, "get_api_key", get_key)

    result = await route.put_jev_service(
        route.JevServiceUpdate(
            base_url="https://proxy.example",
            api_key="private-test-key",
        ),
    )
    assert result == {"base_url": "https://proxy.example", "configured": True}
    assert config.jev_service.base_url == "https://proxy.example"
    assert "private-test-key" not in str(result)
    assert await route.get_jev_service() == result

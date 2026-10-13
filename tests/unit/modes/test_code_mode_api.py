# -*- coding: utf-8 -*-
"""Code Mode API persists the single execution switch."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from qwenpaw.app.routers import coding_mode
from qwenpaw.config.config import AgentProfileConfig


def test_mode_roundtrip_enables_and_disables_python_interface(monkeypatch):
    config = AgentProfileConfig(id="demo", name="Demo")
    saved = []
    monkeypatch.setattr(
        coding_mode,
        "get_agent_for_request",
        AsyncMock(
            return_value=SimpleNamespace(agent_id="demo"),
        ),
    )
    monkeypatch.setattr(coding_mode, "load_agent_config", lambda _id: config)
    monkeypatch.setattr(
        coding_mode,
        "save_agent_config",
        lambda _id, value: saved.append(value.model_copy(deep=True)),
    )
    monkeypatch.setattr(coding_mode, "schedule_agent_reload", lambda *_: None)
    app = FastAPI()
    app.include_router(coding_mode.router)
    with TestClient(app) as client:
        assert client.get("/coding-mode").json()["enabled"] is False
        response = client.post(
            "/coding-mode",
            json={
                "enabled": True,
            },
        )
        assert response.json() == {
            "enabled": True,
            "agent_id": "demo",
        }
        assert client.get("/coding-mode").json()["enabled"] is True
        client.post("/coding-mode", json={"enabled": False})
        assert saved[-1].coding_mode.enabled is False
        assert (
            client.post(
                "/coding-mode",
                json={
                    "enabled": "unsupported",
                },
            ).status_code
            == 422
        )

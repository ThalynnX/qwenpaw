# -*- coding: utf-8 -*-
"""Third-party agent catalog and authentication endpoints."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..agent_context import get_agent_for_request
from ...harnesses.base import HarnessAdapter, HarnessOperationNotSupportedError
from ...harnesses.registry import get_provider

router = APIRouter(prefix="/harnesses", tags=["harnesses"])


class HarnessLoginRequest(BaseModel):
    """Options for starting a provider login."""

    device_code: bool = False
    settings: dict[str, Any] = Field(default_factory=dict)


class HarnessStatusRequest(BaseModel):
    """Provider settings used for one live status probe."""

    settings: dict[str, Any] = Field(default_factory=dict)


@router.get("")
async def get_harnesses(request: Request) -> dict:
    """Return supported and planned third-party agent backends."""
    workspace = await get_agent_for_request(request)
    config = workspace.config
    provider_settings = {
        config.backend: dict(config.backend_settings),
    }
    providers = await workspace.harness_runtime.providers(provider_settings)
    return {"providers": [item.model_dump() for item in providers]}


def _supported_provider(provider_id: str):
    """Resolve an enabled provider or return a client-facing error."""
    try:
        provider = get_provider(provider_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if provider.coming_soon:
        raise HTTPException(
            status_code=409,
            detail=f"{provider.name} is not available yet",
        )
    return provider


async def _capability_unavailable_message(
    adapter: HarnessAdapter,
) -> str | None:
    """Read provider availability without blocking the event loop."""
    return await asyncio.to_thread(
        getattr,
        adapter,
        "capability_unavailable_message",
    )


def _operation_message(exc: RuntimeError) -> str:
    """Return a client-safe explanation without leaking a traceback."""
    return str(exc).strip() or "This provider cannot perform the operation."


@router.get("/{provider_id}/models")
async def get_harness_models(
    provider_id: str,
    request: Request,
) -> dict:
    """Return provider-owned models for the current account."""
    _supported_provider(provider_id)
    workspace = await get_agent_for_request(request)
    config = workspace.config
    settings = (
        dict(config.backend_settings) if config.backend == provider_id else {}
    )
    adapter = await workspace.harness_runtime.adapter(provider_id, settings)
    unavailable_message = await _capability_unavailable_message(adapter)
    if unavailable_message:
        return {
            "models": [],
            "message": unavailable_message,
        }
    models = await adapter.models()
    return {"models": [item.model_dump() for item in models]}


@router.get("/{provider_id}/mcp")
async def get_harness_mcp(
    provider_id: str,
    request: Request,
) -> dict:
    """Return read-only MCP servers owned by one Provider."""
    provider = _supported_provider(provider_id)
    if not provider.capabilities.provider_mcp_discovery:
        return {"servers": []}
    workspace = await get_agent_for_request(request)
    config = workspace.config
    settings = (
        dict(config.backend_settings) if config.backend == provider_id else {}
    )
    adapter = await workspace.harness_runtime.adapter(provider_id, settings)
    unavailable_message = await _capability_unavailable_message(adapter)
    if unavailable_message:
        return {
            "servers": [],
            "message": unavailable_message,
        }
    servers = await adapter.discover_mcp(workspace.workspace_dir.resolve())
    return {"servers": [item.model_dump() for item in servers]}


@router.get("/{provider_id}/skills")
async def get_harness_skills(
    provider_id: str,
    request: Request,
) -> dict:
    """Return read-only Skills owned by one Provider."""
    provider = _supported_provider(provider_id)
    if not provider.capabilities.provider_skills_discovery:
        return {"skills": []}
    workspace = await get_agent_for_request(request)
    config = workspace.config
    settings = (
        dict(config.backend_settings) if config.backend == provider_id else {}
    )
    adapter = await workspace.harness_runtime.adapter(provider_id, settings)
    unavailable_message = await _capability_unavailable_message(adapter)
    if unavailable_message:
        return {
            "skills": [],
            "message": unavailable_message,
        }
    skills = await adapter.discover_skills(
        workspace.workspace_dir.resolve(),
    )
    return {"skills": [item.model_dump() for item in skills]}


@router.post("/{provider_id}/status")
async def post_harness_status(
    provider_id: str,
    body: HarnessStatusRequest,
    request: Request,
) -> dict:
    """Probe a provider using unsaved agent backend settings."""
    _supported_provider(provider_id)
    workspace = await get_agent_for_request(request)
    adapter = await workspace.harness_runtime.adapter(
        provider_id,
        body.settings,
    )
    provider = await adapter.status()
    provider.capabilities = get_provider(provider_id).capabilities
    return provider.model_dump()


@router.post("/{provider_id}/login")
async def post_harness_login(
    provider_id: str,
    body: HarnessLoginRequest,
    request: Request,
) -> dict:
    """Start a provider-owned login flow."""
    _supported_provider(provider_id)
    workspace = await get_agent_for_request(request)
    adapter = await workspace.harness_runtime.adapter(
        provider_id,
        body.settings,
    )
    try:
        return await adapter.start_login(device_code=body.device_code)
    except HarnessOperationNotSupportedError as exc:
        raise HTTPException(
            status_code=409,
            detail=_operation_message(exc),
        ) from exc
    except RuntimeError as exc:
        # Optional providers raise RuntimeError until their dependency is
        # installed (e.g. "Install qwenpaw[codex] to enable Codex.").
        raise HTTPException(
            status_code=409,
            detail=_operation_message(exc),
        ) from exc


@router.post("/{provider_id}/logout")
async def post_harness_logout(
    provider_id: str,
    body: HarnessStatusRequest,
    request: Request,
) -> dict:
    """Log out through the provider-owned runtime."""
    _supported_provider(provider_id)
    workspace = await get_agent_for_request(request)
    adapter = await workspace.harness_runtime.adapter(
        provider_id,
        body.settings,
    )
    try:
        await adapter.logout()
    except HarnessOperationNotSupportedError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "logout_not_supported",
                "message": _operation_message(exc),
            },
        ) from exc
    except RuntimeError as exc:
        # Missing optional dependencies surface as RuntimeError; map them
        # to the same structured 409 shape instead of a bare 500.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "logout_unavailable",
                "message": _operation_message(exc),
            },
        ) from exc
    return {"ok": True}


__all__ = ["router"]

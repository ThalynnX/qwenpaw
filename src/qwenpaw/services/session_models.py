# -*- coding: utf-8 -*-
"""Resolve session model choices without changing agent defaults."""

from ..config.config import ModelSlotConfig, ModelType, load_agent_config
from ..providers.provider_manager import ProviderManager
from ..utils.io_utils import run_sync_io


def session_model(
    meta: dict | None, model_type: ModelType = "chat"
) -> ModelSlotConfig | None:
    """Read one model choice owned by this conversation."""
    key = "model" if model_type == "chat" else "decision_model"
    raw = ((meta or {}).get("runtime_context") or {}).get(key)
    return ModelSlotConfig.model_validate(raw) if raw is not None else None


async def decision_model_view(workspace, model_override=None) -> dict:
    """Resolve session → agent → global, exposing only usable models."""

    def resolve():
        config = load_agent_config(workspace.agent_id)
        manager = ProviderManager.get_instance()
        slot = model_override or manager.get_default_model("decision", config)
        provider = manager.get_provider(slot.provider_id) if slot else None
        info = provider.get_model_info(slot.model) if provider else None
        available = (
            config.backend == "qwenpaw"
            and provider is not None
            and provider.enabled
            and info is not None
            and info.model_type == "decision"
            and info.availability_status
            not in {"permission_denied", "model_not_found", "incompatible_api"}
        )
        return {
            "provider_id": slot.provider_id if available else None,
            "model": slot.model if available else None,
            "model_name": info.name if available else None,
            "model_source": (
                "session"
                if model_override
                else "agent"
                if config.decision_model
                else "global"
            ),
        }

    return await run_sync_io(resolve)

# -*- coding: utf-8 -*-
"""Shared validation for global and per-agent model selections."""

from fastapi import HTTPException

from ...config.config import ModelType
from ...providers.provider_manager import ProviderManager


def validate_model_slot(
    manager: ProviderManager,
    provider_id: str,
    model_id: str,
    model_type: ModelType = "chat",
) -> None:
    """Validate that the provider and model exist without mutating state."""
    provider = manager.get_provider(provider_id)
    if provider is None:
        raise HTTPException(
            status_code=404,
            detail=f"Provider '{provider_id}' not found.",
        )
    if not provider.has_model(model_id):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Model '{model_id}' not found in provider "
                f"'{provider_id}'."
            ),
        )
    model_info = provider.get_model_info(model_id)
    if model_info is not None and model_info.model_type != model_type:
        raise HTTPException(
            status_code=400,
            detail=f"Model '{model_id}' is not a {model_type} model.",
        )
    if model_info and model_info.availability_status in {
        "permission_denied",
        "model_not_found",
        "incompatible_api",
    }:
        reason = (
            model_info.availability_message or model_info.availability_status
        )
        raise HTTPException(
            status_code=400,
            detail=f"Model '{model_id}' cannot be activated: {reason}",
        )

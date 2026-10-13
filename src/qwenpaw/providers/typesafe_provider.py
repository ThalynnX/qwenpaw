# -*- coding: utf-8 -*-
"""TypeSafe account configuration and decision model discovery."""

from __future__ import annotations

from typing import List

import httpx

from .provider import ModelConnectionResult, ModelInfo, Provider


class TypeSafeProvider(Provider):
    """Manage TypeSafe models using the standard provider lifecycle."""

    chat_model: str = ""

    async def fetch_models(self, timeout: float = 5) -> List[ModelInfo]:
        async with httpx.AsyncClient(
            headers={
                **self.custom_headers,
                "Authorization": f"Bearer {self.api_key}",
            },
        ) as client:
            response = await client.get(
                self.base_url.rstrip("/") + "/models",
                timeout=timeout,
            )
            response.raise_for_status()
            return [
                ModelInfo(
                    id=row["name"],
                    name=row["name"],
                    model_type="decision",
                    supports_multimodal=False,
                    supports_image=False,
                    supports_video=False,
                    supports_audio=False,
                    supports_tool_calling=False,
                )
                for row in response.json()["models"]
            ]

    async def check_connection(self, timeout: float = 5) -> tuple[bool, str]:
        try:
            await self.fetch_models(timeout)
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            return False, self.connection_error_message(exc)
        return True, ""

    async def check_model_connection(
        self,
        model_id: str,
        timeout: float = 5,
    ) -> ModelConnectionResult:
        async with self.get_decision_model_instance(model_id) as model:
            return await model.check_connection(timeout)

# -*- coding: utf-8 -*-
"""The Jev transport accepts questions outside the security domain."""

import json

import httpx
import pytest

from qwenpaw.services.jev import JevClient, JevRequest, JevServiceError


@pytest.mark.asyncio
async def test_context_management_question_uses_generic_client(monkeypatch):
    import qwenpaw.services.jev as service

    async def key():
        return "test-key"

    monkeypatch.setattr(service, "get_api_key", key)
    original_client = httpx.AsyncClient

    def handler(request):
        body = json.loads(request.content)
        assert request.url.host == "proxy.example"
        assert request.url.path == "/v1/systemone"
        assert body["state"] == {"summary": "conversation segment"}
        assert body["questions"]["keep_in_context"]["type"] == "noul"
        return httpx.Response(
            200,
            json={
                "model": "jev-1",
                "answers": {"keep_in_context": {"type": "noul", "noul": 0.8}},
                "usage": {"input_tokens": 20, "output_tokens": 4},
            },
        )

    monkeypatch.setattr(
        service.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(
            transport=httpx.MockTransport(handler),
            **kwargs,
        ),
    )
    result = await JevClient(base_url="https://proxy.example").evaluate(
        JevRequest(
            state={"summary": "conversation segment"},
            questions={
                "keep_in_context": {
                    "type": "noul",
                    "instructions": "Keep this in active context?",
                },
            },
        ),
    )
    assert result.answers["keep_in_context"]["noul"] == 0.8


@pytest.mark.asyncio
async def test_missing_key_is_explicit_error(monkeypatch):
    async def no_key():
        return None

    monkeypatch.setattr("qwenpaw.services.jev.get_api_key", no_key)
    with pytest.raises(JevServiceError, match="not configured"):
        await JevClient().evaluate(
            JevRequest(
                state="x",
                questions={"q": {"type": "noul", "instructions": "x"}},
            ),
        )

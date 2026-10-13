# -*- coding: utf-8 -*-
"""Typed System One decisions shared by model service providers."""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

import httpx
from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from ..exceptions import ProviderError
from .provider import ModelConnectionResult


class ChoiceQuestion(BaseModel):
    type: Literal["choice"] = "choice"
    instructions: str
    criteria: dict[str, Any] = Field(min_length=1, max_length=255)


class ScoreQuestion(BaseModel):
    type: Literal["score"] = "score"
    instructions: str
    criteria: list[Any] = Field(min_length=2, max_length=10)


class NoulQuestion(BaseModel):
    type: Literal["noul"] = "noul"
    instructions: str
    criteria: dict[Literal["true", "false"], Any] | None = None


Question = Annotated[
    ChoiceQuestion | ScoreQuestion | NoulQuestion,
    Field(discriminator="type"),
]
Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class ChoiceAnswer(BaseModel):
    type: Literal["choice"]
    choice: str
    probabilities: dict[str, Probability]
    confidence: Probability


class ScoreAnswer(BaseModel):
    type: Literal["score"]
    score: float = Field(allow_inf_nan=False)
    legend: dict[str, Any]
    probabilities: dict[str, Probability]
    confidence: Probability


class NoulAnswer(BaseModel):
    type: Literal["noul"]
    noul: Probability


Answer = Annotated[
    ChoiceAnswer | ScoreAnswer | NoulAnswer,
    Field(discriminator="type"),
]


class DecisionUsage(BaseModel):
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)


class DecisionResponse(BaseModel):
    model: str
    answers: dict[str, Answer]
    usage: DecisionUsage = Field(default_factory=DecisionUsage)
    request_id: str | None = None


class SystemOneDecisionModel:
    """A task-scoped client; configuration is captured when it is created."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        url = httpx.URL(base_url)
        if url.scheme not in {"http", "https"} or not url.host:
            raise ProviderError(message="Invalid decision model Base URL")
        self.model = model
        self.url = base_url.rstrip("/") + "/systemone"
        self._headers = {
            **(headers or {}),
            "Authorization": f"Bearer {api_key}",
        }
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> SystemOneDecisionModel:
        self._client = httpx.AsyncClient(headers=self._headers)
        return self

    async def __aexit__(self, *_args: Any) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def evaluate(
        self,
        *,
        state: str | dict | list,
        questions: dict[str, Question],
        timeout: float = 10,
    ) -> DecisionResponse:
        """Evaluate atomic questions without applying business thresholds."""
        if self._client is None:
            raise RuntimeError("Use the decision model as an async context")
        if not isinstance(state, (str, dict, list)) or not questions:
            raise ValueError("State and at least one question are required")
        if timeout <= 0:
            raise ValueError("Timeout must be positive")
        parsed = TypeAdapter(dict[str, Question]).validate_python(questions)
        payload = {
            "model": self.model,
            "state": state,
            "questions": {
                key: value.model_dump(exclude_none=True)
                for key, value in parsed.items()
            },
        }
        try:
            async with asyncio.timeout(timeout):
                for attempt in range(2):
                    response = await self._client.post(
                        self.url,
                        json=payload,
                        timeout=timeout,
                    )
                    if attempt == 0 and (
                        response.status_code == 429
                        or response.status_code >= 500
                    ):
                        try:
                            delay = max(
                                0.0,
                                float(
                                    response.headers.get("retry-after", "0.5"),
                                ),
                            )
                        except ValueError:
                            delay = 0.5
                        await asyncio.sleep(delay)
                        continue
                    response.raise_for_status()
                    result = DecisionResponse.model_validate(response.json())
                    self._validate_answers(result, parsed)
                    return result
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise ProviderError(
                message="Decision model request timed out",
                details={"error_kind": "timeout"},
            ) from exc
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            raise ProviderError(
                message=f"Decision model returned HTTP {status}",
                details={"http_status": status},
            ) from exc
        except httpx.RequestError as exc:
            raise ProviderError(
                message="Could not connect to decision model",
                details={"error_kind": "network"},
            ) from exc
        except (ValidationError, ValueError) as exc:
            raise ProviderError(
                message="Decision model returned an invalid response",
                details={"error_kind": "invalid_response"},
            ) from exc
        raise RuntimeError("Decision model request did not complete")

    @staticmethod
    def _validate_answers(
        result: DecisionResponse,
        questions: dict[str, Question],
    ) -> None:
        if result.answers.keys() != questions.keys():
            raise ValueError("Answer IDs must match question IDs")
        for key, question in questions.items():
            answer = result.answers[key]
            if answer.type != question.type:
                raise ValueError("Answer type does not match its question")
            if isinstance(answer, NoulAnswer):
                continue
            if abs(sum(answer.probabilities.values()) - 1) > 0.001:
                raise ValueError("Probabilities must sum to one")
            if isinstance(question, ChoiceQuestion) and isinstance(
                answer,
                ChoiceAnswer,
            ):
                if (
                    answer.choice not in question.criteria
                    or answer.probabilities.keys() != question.criteria.keys()
                ):
                    raise ValueError("Answer contains an unknown choice")
            elif isinstance(question, ScoreQuestion) and isinstance(
                answer,
                ScoreAnswer,
            ):
                levels = {str(i) for i in range(len(question.criteria))}
                if (
                    answer.probabilities.keys() != levels
                    or answer.legend.keys() != levels
                    or not 0 <= answer.score <= len(levels) - 1
                ):
                    raise ValueError("Answer contains an invalid score")

    async def check_connection(
        self,
        timeout: float = 5,
    ) -> ModelConnectionResult:
        """Check all three primitives through the same execution path."""
        try:
            await self.evaluate(
                state="A customer asks to check their invoice.",
                questions={
                    "team": ChoiceQuestion(
                        instructions="Select the relevant team.",
                        criteria={"billing": "Invoices", "other": "Other"},
                    ),
                    "invoice": NoulQuestion(
                        instructions="Does the request mention an invoice?",
                    ),
                    "urgency": ScoreQuestion(
                        instructions="Rate the urgency.",
                        criteria=["Routine", "Urgent"],
                    ),
                },
                timeout=timeout,
            )
        except ProviderError as exc:
            details = exc.details or {}
            return ModelConnectionResult(
                success=False,
                message=str(exc),
                http_status=details.get("http_status"),
                error_kind=details.get("error_kind"),
            )
        return ModelConnectionResult(success=True)

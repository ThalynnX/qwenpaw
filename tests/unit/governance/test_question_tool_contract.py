# -*- coding: utf-8 -*-
"""Guard adapters preserve explicit schemas and distinguish tool refusals."""
# The guard adapters create callable subclasses dynamically in __new__.
# pylint: disable=protected-access,not-callable

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from agentscope.message import TextBlock, ToolResultState
from agentscope.permission import PermissionBehavior, PermissionDecision
from agentscope.tool import AskUserParams, FunctionTool, ToolChunk

from qwenpaw.agents.tools import ask_user_question
from qwenpaw.governance import PolicyGuardedTool, tool_adapter
from qwenpaw.governance.policy import GovernanceAction, ToolCallSpec
from qwenpaw.runtime.tool_guard import GuardedFunctionTool
from qwenpaw.runtime.tool_registry import ToolDescriptor


def _question_function():
    """A deliberately weak annotation must yield to the framework schema."""

    def question_tool(questions: str) -> str:
        """Ask questions."""
        return questions

    return question_tool


def _attach_framework_schema(function):
    function._tool_descriptor = ToolDescriptor(
        name="question_tool",
        func=function,
        metadata={"input_schema": AskUserParams},
    )


@pytest.mark.parametrize("guard", [PolicyGuardedTool, GuardedFunctionTool])
def test_guard_publishes_framework_question_schema(guard):
    function = _question_function()
    _attach_framework_schema(function)
    tool = guard(function)
    schema = tool.input_schema
    expected = FunctionTool(function, input_schema=AskUserParams).input_schema
    assert schema == expected
    assert schema["properties"]["questions"]["minItems"] == 1
    assert schema["properties"]["questions"]["maxItems"] == 4
    assert "questions" in schema["required"]


@pytest.mark.parametrize("guard", [PolicyGuardedTool, GuardedFunctionTool])
def test_question_recommendation_guidance_reaches_the_model(guard):
    tool = guard(ask_user_question)
    description = " ".join(tool.description.split())
    assert 'place it first and append "(Recommended)"' in description
    assert "option's description" in description
    assert "leave the labels unmarked" in description
    expected = FunctionTool(
        ask_user_question,
        input_schema=AskUserParams,
    ).input_schema
    assert tool.input_schema == expected
    option_schema = tool.input_schema["$defs"]["_Option"]["properties"]
    assert set(option_schema) == {"label", "description", "preview"}


@pytest.mark.parametrize("guard", [PolicyGuardedTool, GuardedFunctionTool])
def test_explicit_schema_keeps_priority_over_descriptor(guard):
    function = _question_function()
    _attach_framework_schema(function)
    override = {
        "type": "object",
        "properties": {"custom": {"type": "string"}},
        "required": ["custom"],
    }
    assert guard(function, input_schema=override).input_schema == override


@pytest.mark.parametrize("guard", [PolicyGuardedTool, GuardedFunctionTool])
def test_functions_without_descriptors_keep_inferred_schema(guard):
    function = _question_function()
    assert guard(function).input_schema == FunctionTool(function).input_schema


async def test_tool_refusal_is_returned_without_another_approval(monkeypatch):
    denied = ToolChunk(
        is_last=True,
        state=ToolResultState.DENIED,
        content=[TextBlock(text="The user declined to answer.")],
        metadata={"outcome": "declined"},
    )

    async def refuse():
        return denied

    ask = AsyncMock()
    monkeypatch.setattr(tool_adapter, "_ask_user_approval", ask)
    governor = SimpleNamespace(audit=Mock())
    result = await PolicyGuardedTool(refuse, governor=governor)()
    assert result is denied
    assert result.metadata == {"outcome": "declined"}
    ask.assert_not_awaited()
    governor.audit.assert_not_called()


@pytest.mark.parametrize("marker_in_metadata", [True, False])
async def test_sandbox_violation_still_asks_and_retries_when_allowed(
    marker_in_metadata,
    monkeypatch,
):
    """Both structured and legacy text violations retain the existing gate."""
    sandbox = object()
    executions = []

    async def execute(sandbox_config=None):
        executions.append(sandbox_config)
        if sandbox_config is not None:
            return ToolChunk(
                is_last=True,
                state=ToolResultState.DENIED,
                content=[
                    TextBlock(
                        text=(
                            "Access was blocked."
                            if marker_in_metadata
                            else "Sandbox violation: blocked target\nDetails."
                        ),
                    ),
                ],
                metadata=(
                    {"sandbox_violation": "blocked target"}
                    if marker_in_metadata
                    else {}
                ),
            )
        return ToolChunk(
            is_last=True,
            state=ToolResultState.SUCCESS,
            content=[TextBlock(text="completed after approval")],
        )

    approval = AsyncMock(
        return_value=PermissionDecision(
            behavior=PermissionBehavior.ALLOW,
            message="User approved the sandbox retry.",
        ),
    )
    monkeypatch.setattr(tool_adapter, "_ask_user_approval", approval)
    governor = SimpleNamespace(audit=Mock())
    tool = PolicyGuardedTool(execute, governor=governor)
    tool._qp_sandbox_mode = True
    tool._qp_sandbox_config = sandbox
    tool._qp_tc_spec = ToolCallSpec(
        tool_name="Bash",
        target="command",
        agent_id="agent",
        session_id="session",
    )
    result = await tool()

    assert result.state == ToolResultState.SUCCESS
    assert executions == [sandbox, None]
    approval.assert_awaited_once()
    assert approval.await_args.kwargs["violation_msg"] == "blocked target"
    assert governor.audit.call_args.args[1].action == GovernanceAction.ASK
    assert tool._qp_sandbox_mode is False

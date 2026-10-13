# -*- coding: utf-8 -*-
"""Exercise Python orchestration, native execution and permissions."""

# pylint: disable=protected-access
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import psutil
from agentscope.agent import Agent, ContextConfig
from agentscope.middleware import MiddlewareBase
from agentscope.message import DataBlock, TextBlock, ToolResultState, URLSource
from agentscope.permission import PermissionBehavior, PermissionDecision
from agentscope.skill import Skill
from agentscope.state import AgentState
from agentscope.tool import FunctionTool, ToolChunk

from qwenpaw.config.context import current_recent_max_bytes
from qwenpaw.modes.coding.code_mode import build_code_mode_toolkit
from qwenpaw.agents.middlewares import ToolResultPruningMiddleware
from qwenpaw.runtime.builder import AgentBuilder
from qwenpaw.runtime.prompt_contributors import CodingModeContributor
from qwenpaw.tool_calls import ToolCoordinator, ToolCoordinatorMiddleware
from qwenpaw.modes.coding._process import WorkerProcess
from qwenpaw.config.config import AgentProfileConfig
from qwenpaw.agents.tools import read_file, get_current_time, web_search


def make_tool(func, *, allowed=True):
    """Use native permission decisions rather than a mocked interpreter."""
    return FunctionTool(
        func,
        permission=PermissionDecision(
            behavior=(
                PermissionBehavior.ALLOW
                if allowed
                else PermissionBehavior.DENY
            ),
            message="fixture permission",
            bypass_immune=not allowed,
        ),
    )


async def echo(value: str) -> ToolChunk:
    """Return a deliberately large native tool result."""
    return ToolChunk(
        content=[TextBlock(text=value)],
        state=ToolResultState.SUCCESS,
    )


def output_text(result):
    """Collect only text emitted by a script."""
    return "".join(b.text for b in result.content if isinstance(b, TextBlock))


async def run_script(kit, code, state=None):
    """Run the actual sole entry point with a native agent state."""
    return await (await kit.get_tool("run_code")).call(
        code,
        state or AgentState(),
    )


async def test_hidden_catalog_still_executes_and_filters():
    kit = build_code_mode_toolkit(
        skills_or_loaders=[],
        tools=[make_tool(echo)],
    )
    schemas = await kit.get_tool_schemas()
    names = {s["function"]["name"] for s in schemas}
    description = schemas[0]["function"]["description"]
    assert "tools.echo" in description
    assert '"value"' in description
    assert "Keyword arguments" in description
    assert names == {"run_code"}
    result = await run_script(
        kit,
        'r = await tools.echo(value="secret" * 1000)\n'
        'text(len(r["content"][0]["text"]))',
        AgentState(),
    )
    assert result.state == ToolResultState.SUCCESS, output_text(result)
    assert output_text(result) == "6000"
    assert result.metadata["code_mode"]["calls"] == [
        {"name": "echo", "state": "success"},
    ]
    with pytest.raises(Exception, match="doesn.t exist"):
        await kit.check_tool_available("echo", [])


async def test_permission_denial_cannot_be_bypassed_by_code():
    invoked = []

    async def write_secret() -> ToolChunk:
        invoked.append(True)
        return ToolChunk(content=[])

    kit = build_code_mode_toolkit(
        skills_or_loaders=[],
        tools=[make_tool(write_secret, allowed=False)],
    )
    result = await run_script(
        kit,
        "await tools.write_secret()",
        AgentState(),
    )
    assert result.state == ToolResultState.ERROR
    assert not invoked
    assert "fixture permission" in output_text(result)


async def test_native_permission_middleware_receives_nested_call():
    kit = build_code_mode_toolkit(
        skills_or_loaders=[],
        tools=[make_tool(echo)],
    )
    code_tool = await kit.get_tool("run_code")
    code_tool.check_permission = AsyncMock(
        return_value=PermissionDecision(
            behavior=PermissionBehavior.DENY,
            message="plan gate",
        ),
    )
    result = await run_script(
        kit,
        'await tools.echo(value="blocked")',
        AgentState(),
    )
    assert "plan gate" in output_text(result)
    code_tool.check_permission.assert_awaited_once()


async def test_parallel_calls_overlap_and_keep_native_metadata():
    both_started = asyncio.Event()
    active = 0

    async def lookup(value: str) -> ToolChunk:
        nonlocal active
        active += 1
        if active == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=2)
        if value == "bad":
            raise ValueError(f"simulated lookup failure")
        return ToolChunk(
            content=[TextBlock(text=value)],
            state=ToolResultState.SUCCESS,
            metadata={"value": value},
        )

    kit = build_code_mode_toolkit(
        skills_or_loaders=[],
        tools=[make_tool(lookup)],
    )
    result = await run_script(
        kit,
        "import asyncio\n"
        'rs = await asyncio.gather(tools.lookup(value="a"), '
        'tools.lookup(value="b"))\n'
        '[r["metadata"]["value"] for r in rs]',
        AgentState(),
    )
    assert result.state == ToolResultState.SUCCESS, output_text(result)
    assert output_text(result) == '["a", "b"]'

    partial_result = await run_script(
        kit,
        "import asyncio\n"
        'rs = await asyncio.gather(tools.lookup(value="a"), '
        'tools.lookup(value="bad"), return_exceptions=True)\n'
        'text([{"error": str(r)} if isinstance(r, Exception) else '
        '{"value": r["metadata"]["value"]} for r in rs])',
    )
    assert partial_result.state == ToolResultState.SUCCESS
    assert '"value": "a"' in output_text(partial_result)
    assert "simulated lookup failure" in output_text(partial_result)


@pytest.mark.parametrize(
    "code",
    [
        'await tools.run_code(code="1")',
        "await tools.disabled()",
        "await tools.echo(wrong=1)",
        'await tools.echo("positional")',
        'open("/etc/passwd").read()',
        'import subprocess\nsubprocess.run(["echo", "unsafe"])',
        'import socket\nsocket.create_connection(("127.0.0.1", 8088))',
        'open("/tmp/qwenpaw-code-denied", "w").write("unsafe")',
    ],
)
async def test_invalid_and_unexposed_capabilities_fail(code):
    kit = build_code_mode_toolkit(
        skills_or_loaders=[],
        tools=[make_tool(echo)],
    )
    result = await run_script(kit, code, AgentState())
    assert result.state == ToolResultState.ERROR


async def test_cancellation_reaches_inflight_host_calls(monkeypatch):
    started = asyncio.Event()
    stopped = asyncio.Event()
    worker_pids = []
    enter = WorkerProcess.__aenter__

    async def record_worker(worker):
        result = await enter(worker)
        worker_pids.append(worker.process.pid)
        return result

    monkeypatch.setattr(WorkerProcess, "__aenter__", record_worker)

    async def wait_forever() -> ToolChunk:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    kit = build_code_mode_toolkit(
        skills_or_loaders=[],
        tools=[make_tool(wait_forever)],
    )
    task = asyncio.create_task(
        run_script(
            kit,
            "await tools.wait_forever()",
            AgentState(),
        ),
    )
    await asyncio.wait_for(started.wait(), timeout=3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.wait_for(stopped.wait(), timeout=3)
    assert worker_pids and not psutil.pid_exists(worker_pids[0])


async def test_print_budget_and_native_image_output():
    kit = build_code_mode_toolkit(skills_or_loaders=[], tools=[])
    token = current_recent_max_bytes.set(32)
    try:
        result = await run_script(kit, 'print("x" * 1000)', AgentState())
    finally:
        current_recent_max_bytes.reset(token)
    assert "truncated" in output_text(result)
    assert len(output_text(result)) < 100
    block = DataBlock(
        source=URLSource(
            url="file:///tmp/example.png",
            media_type="image/png",
        ),
    )
    rejected = await run_script(
        kit,
        f'image({block.model_dump(mode="json")!r})',
    )
    assert rejected.state == ToolResultState.ERROR

    async def read_image() -> ToolChunk:
        return ToolChunk(content=[block])

    kit = build_code_mode_toolkit(
        tools=[make_tool(read_image)],
        skills_or_loaders=[],
    )
    result = await run_script(
        kit,
        'r = await tools.read_image()\nimage(r["content"][0])',
    )
    assert result.state == ToolResultState.SUCCESS, output_text(result)
    assert isinstance(result.content[0], DataBlock)


async def test_builder_keeps_enabled_tools_in_script_catalog_only():
    local = SimpleNamespace(
        list_tools=AsyncMock(
            return_value=[
                make_tool(read_file),
                make_tool(get_current_time),
                make_tool(web_search),
                make_tool(echo),
            ],
        ),
    )
    builder = AgentBuilder()
    builder._get_local_workspace = lambda _ctx: local
    builder._load_runtime_skills = lambda *_args: []
    config = AgentProfileConfig(id="test", name="test")
    config.coding_mode.enabled = True
    ctx = SimpleNamespace(extras={})
    kit = await builder.build_toolkit(config, ctx=ctx)
    names = {
        s["function"]["name"]
        for s in await (
            await kit.get_tool("run_code")
        ).toolkit.get_tool_schemas()
    }
    assert names == {"read_file", "get_current_time", "web_search", "echo"}
    schema = (await kit.get_tool_schemas())[0]["function"]
    assert "tools.web_search" in schema["description"]
    assert '"search_term"' in schema["description"]
    discovery = await run_script(
        kit,
        'text(await search_tools("web"))\n'
        'text(await describe_tool("web_search"))',
    )
    assert "search_term" in output_text(discovery)
    assert discovery.state == ToolResultState.SUCCESS
    assert [tool.name for tool in kit.tool_groups[0].tools] == ["run_code"]


async def test_only_keeps_skills_scriptable_without_exposing_a_second_tool():
    kit = build_code_mode_toolkit(
        tools=[],
        skills_or_loaders=[
            Skill(
                "demo",
                "Demo skill",
                "/tmp/demo",
                "# Demo\nFollow the project instructions.",
                0,
            ),
        ],
    )
    assert [s["function"]["name"] for s in await kit.get_tool_schemas()] == [
        "run_code",
    ]
    assert "tools.Skill" in await kit.get_skill_instructions()
    result = await run_script(kit, 'await tools.Skill(skill="demo")')
    assert result.state == ToolResultState.SUCCESS, output_text(result)
    assert "Follow the project instructions" in output_text(result)


async def test_control_tools_receive_native_state_inside_only_mode():
    async def finish_task(_agent_state: AgentState) -> ToolChunk:
        _agent_state.middle_context["finished"] = True
        return ToolChunk(
            content=[TextBlock(text="finished")],
            state=ToolResultState.SUCCESS,
        )

    control = FunctionTool(
        finish_task,
        is_state_injected=True,
        input_schema={"type": "object", "properties": {}},
        permission=PermissionDecision(
            behavior=PermissionBehavior.ALLOW,
            message="fixture control",
        ),
    )
    kit = build_code_mode_toolkit(
        tools=[control],
        skills_or_loaders=[],
    )
    state = AgentState()
    result = await run_script(kit, "await tools.finish_task()", state)
    assert result.state == ToolResultState.SUCCESS, output_text(result)
    assert state.middle_context["finished"] is True


async def test_native_python_chains_and_reduces_with_standard_asyncio():
    kit = build_code_mode_toolkit(
        tools=[make_tool(echo)],
        skills_or_loaders=[],
    )
    result = await run_script(
        kit,
        "import asyncio, json\n"
        "gate = asyncio.Semaphore(2)\n"
        "async def chain(value):\n"
        "    async with gate:\n"
        "        first = await tools.echo(value=str(value))\n"
        '        number = int(first["content"][0]["text"])\n'
        "        return await tools.echo(value=str(number * 2))\n"
        "async with asyncio.TaskGroup() as group:\n"
        "    tasks = [group.create_task(chain(v)) for v in [2, 1, 2]]\n"
        'numbers = [int(t.result()["content"][0]["text"]) for t in tasks]\n'
        'text(json.dumps({"unique": sorted(set(numbers)), '
        '"sum": sum(numbers)}))',
    )
    assert result.state == ToolResultState.SUCCESS, output_text(result)
    assert json.loads(output_text(result)) == {"unique": [2, 4], "sum": 10}
    assert len(result.metadata["code_mode"]["calls"]) == 6


async def test_native_pipeline_and_dynamic_tools_keep_one_model_entry():
    observed = []

    class Trace(MiddlewareBase):
        async def on_check_permission(
            self,
            agent,
            input_kwargs,
            next_handler,
        ):
            assert agent.toolkit is kit
            observed.append(("permission", input_kwargs["tool_call"].name))
            return await next_handler()

        async def on_acting(self, agent, input_kwargs, next_handler):
            assert agent.toolkit is kit
            observed.append(("acting", input_kwargs["tool_call"].name))
            async for item in next_handler():
                yield item

    async def before(arguments, context):
        observed.append(("before", context.tool_name))
        await asyncio.sleep(0.2)
        return {**arguments, "value": "native middleware result" * 1000}

    async def after(response, context):
        observed.append(("after", context.tool_name))
        return response

    coordinator = ToolCoordinator(
        default_timeout_secs=0.3,
        offload_on_deadline=True,
    )
    coordinator.hooks.register("echo", before=before, after=after)
    kit = build_code_mode_toolkit(
        tools=[make_tool(echo)],
        skills_or_loaders=[],
    )
    agent = Agent(
        name="fixture",
        system_prompt="fixture",
        model=SimpleNamespace(context_size=32768),
        toolkit=kit,
        context_config=ContextConfig(compression_tool_enabled=True),
        middlewares=[
            Trace(),
            ToolResultPruningMiddleware(recent_max_bytes=512),
            ToolCoordinatorMiddleware(coordinator),
        ],
    )
    code = await kit.get_tool("run_code")
    code.check_permission = agent._check_permission
    code.acting = agent._acting
    for _ in range(2):
        model_input = await agent._prepare_model_input()
        assert [s["function"]["name"] for s in model_input["tools"]] == [
            "run_code",
        ]
    assert await kit.catalog.get_tool("CompressContext") is not None
    with pytest.raises(Exception, match="doesn.t exist"):
        await kit.check_tool_available("echo", [])
    result = await run_script(
        kit,
        'r = await tools.echo(value="original")\n'
        'text(len(r["content"][0]["text"]))',
        agent.state,
    )
    assert result.state == ToolResultState.SUCCESS, output_text(result)
    assert output_text(result) == str(len("native middleware result" * 1000))
    assert observed == [
        ("permission", "echo"),
        ("acting", "echo"),
        ("before", "echo"),
        ("after", "echo"),
    ]
    assert agent.state.context == []


@pytest.mark.parametrize("stateful", [False, True])
async def test_unsafe_and_stateful_tools_are_exclusive(stateful):
    active = 0
    peak = 0

    async def mutate(_agent_state=None) -> ToolChunk:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.02)
            return ToolChunk(content=[])
        finally:
            active -= 1

    tool = FunctionTool(
        mutate,
        is_concurrency_safe=stateful,
        is_state_injected=stateful,
        input_schema={"type": "object", "properties": {}},
        permission=PermissionDecision(
            behavior=PermissionBehavior.ALLOW,
            message="fixture mutation",
        ),
    )
    kit = build_code_mode_toolkit(tools=[tool], skills_or_loaders=[])
    result = await run_script(
        kit,
        "import asyncio\nawait asyncio.gather(tools.mutate(), tools.mutate())",
    )
    assert result.state == ToolResultState.SUCCESS, output_text(result)
    assert peak == 1 and active == 0


def test_prompt_explains_the_code_mode_execution_contract():
    config = AgentProfileConfig(id="test", name="test")
    config.coding_mode.enabled = True
    prompt = CodingModeContributor().contribute_sync(
        SimpleNamespace(extras={"agent_config": config}),
    )
    assert "Batch independent calls" in prompt
    assert "return_exceptions=True" in prompt
    assert "await tools.<name>" in prompt
    assert "filter large results" in prompt

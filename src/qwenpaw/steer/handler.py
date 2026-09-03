# -*- coding: utf-8 -*-
"""Steer command handler.

The /steer command lets users inject guidance that the agent will pick up
on its next turn. Unlike real-time mid-execution steering (which would
require invasive changes to the reply loop), this implementation stores
the guidance in the request context and appends it to the prompt before
the next agent run.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from agentscope.message import Msg

logger = logging.getLogger(__name__)

STEER_KEY = "steer_guidance"


def make_steer_command_spec() -> Any:
    """Create a CommandSpec for the /steer command."""
    from .slash_command_registry import CommandSpec

    async def _handler(ctx: Any, args: str) -> "Msg | None":
        from agentscope.message import Msg, TextBlock

        guidance = args.strip()
        if not guidance:
            return Msg(
                name="assistant",
                role="assistant",
                content=[
                    TextBlock(
                        type="text",
                        text=(
                            "**Steer Mode**\n\n"
                            "- Usage: `/steer <guidance>`\n"
                            "- Example: `/steer Focus on the error handling first`\n"
                            "- The agent will pick up your guidance on the next turn"
                        ),
                    )
                ],
            )

        # Store guidance in request extras for the runtime to pick up
        ctx.extras[STEER_KEY] = guidance
        logger.info("[STEER] User guidance: %s", guidance)

        return Msg(
            name="assistant",
            role="assistant",
            content=[
                TextBlock(
                    type="text",
                    text=(
                        f"**Steer Mode Activated**\n\n"
                        f"> {guidance}\n\n"
                        f"- Your guidance has been noted\n"
                        f"- The agent will incorporate this into its next action"
                    ),
                )
            ],
        )

    return CommandSpec(
        name="steer",
        handler=_handler,
        category="conversation",
        help_text="Steer the agent's behavior with guidance",
    )

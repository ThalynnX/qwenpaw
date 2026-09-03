# -*- coding: utf-8 -*-
"""Hook to inject steer guidance into agent context."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..runtime.hooks import HookContext, HookResult

logger = logging.getLogger(__name__)

STEER_KEY = "steer_guidance"


def make_steer_injection_hook() -> Any:
    """Create a hook that injects steer guidance before agent execution."""
    from ..runtime.hooks import HookAction, HookResult
    from ..runtime.phases import Phase

    async def _hook(ctx: "HookContext") -> "HookResult":
        guidance = ctx.extras.get(STEER_KEY)
        if not guidance:
            return HookResult(action=HookAction.CONTINUE)

        # Add guidance to context injections
        ctx.inject_context(
            content=f"**User Steering Guidance**\n\n{guidance}\n\n"
                    f"Please consider this guidance while processing the user's request.",
            priority=50,
            source="steer",
        )
        logger.info("[STEER] Injected guidance into context")

        # Clear after injection so it's only used once
        del ctx.extras[STEER_KEY]

        return HookResult(action=HookAction.CONTINUE)

    return {
        "phase": Phase.PRE_AGENT_BUILD,
        "hook": _hook,
    }

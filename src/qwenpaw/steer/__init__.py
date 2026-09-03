# -*- coding: utf-8 -*-
"""Steer mode for mid-execution guidance injection.

The /steer command lets users provide guidance that the agent will pick up
on its next turn. Unlike real-time mid-execution steering (which would
require invasive changes to the reply loop), this implementation stores
the guidance in the request context and injects it before the next agent run.
"""
from .handler import make_steer_command_spec
from .hook import make_steer_injection_hook

__all__ = ["make_steer_command_spec", "make_steer_injection_hook"]

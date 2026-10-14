# -*- coding: utf-8 -*-
"""Tests for desktop backend port allocation."""

import socket
import sys
from contextlib import ExitStack
from unittest.mock import patch

import pytest

from qwenpaw.utils.port import try_bind_port


@pytest.mark.skipif(sys.platform != "win32", reason="Winsock listen semantics")
def test_reused_desktop_port_accepts_parallel_browser_connections(
    tmp_path, monkeypatch,
) -> None:
    from qwenpaw.utils import port

    monkeypatch.setattr(port, "QWENPAW_DESKTOP_PORT", "")
    port_file = tmp_path / "desktop_port"
    port_file.write_text(str(port.find_free_port()), encoding="utf-8")
    number, listener = port.get_stable_port(port_file)
    assert listener is not None
    with ExitStack() as stack:
        stack.enter_context(listener)
        # asyncio calls listen again, but Winsock retains the first backlog.
        listener.listen(2048)
        failures = []
        for index in range(8):
            client = stack.enter_context(socket.socket())
            client.settimeout(0.5)
            try:
                client.connect(("127.0.0.1", number))
            except OSError as exc:
                failures.append((index, type(exc).__name__))
        assert not failures, f"Browser asset connections stalled: {failures}"


def test_try_bind_port_handles_socket_construction_error() -> None:
    with patch(
        "qwenpaw.utils.port.socket.socket",
        side_effect=OSError("file descriptor limit reached"),
    ):
        assert try_bind_port("127.0.0.1", 8088) is None

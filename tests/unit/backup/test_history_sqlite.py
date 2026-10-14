# -*- coding: utf-8 -*-
"""SQLite consistency guarantees for instance backup and restore."""

# pylint: disable=protected-access
from __future__ import annotations

import io
import json
import sqlite3
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from qwenpaw.agents.context.scroll.history import HistoryStore
from qwenpaw.agents.context.types import LogEntry
from qwenpaw.backup._ops import restore
from qwenpaw.backup._ops.create_helpers import add_agent_workspaces
from qwenpaw.backup.models import BackupValidationError


def _agent_json(db_filename: str = "history.db") -> str:
    return json.dumps(
        {
            "running": {
                "light_context_config": {
                    "scroll_config": {"db_filename": db_filename},
                },
            },
        },
    )


@pytest.mark.parametrize(
    f"location",
    [f"relative", f"absolute", f"external", f"parent", f"symlink"],
)
def test_workspace_backup_uses_verified_history_snapshot(
    tmp_path: Path,
    location: str,
) -> None:
    workspace = tmp_path / "workspace"
    db_path = workspace / "state" / "events.db"
    workspace.mkdir()
    filename = f"state/events.db"
    if location == f"absolute":
        filename = str(db_path)
    elif location in (f"external", f"parent", f"symlink"):
        db_path = tmp_path / f"external.db"
        filename = str(db_path)
        if location == f"parent":
            filename = f"../external.db"
        elif location == f"symlink":
            try:
                (workspace / f"linked.db").symlink_to(db_path)
            except OSError:
                pytest.skip(f"symlinks are unavailable")
            filename = f"linked.db"
        (workspace / f"history.db").write_bytes(b"unrelated file")
        (workspace / f"history-1.db-wal").write_bytes(b"unrelated WAL")
    live_config = _agent_json(filename)
    (workspace / f"agent.json").write_text(live_config, encoding=f"utf-8")
    store = HistoryStore(db_path)
    store.append(
        session_id="session",
        agent_id="agent",
        dedup_key="one",
        entry=LogEntry(kind="model_turn", content="durable row"),
    )
    assert Path(str(db_path) + "-wal").exists()

    archive_path = tmp_path / "backup.zip"
    try:
        with zipfile.ZipFile(
            archive_path,
            "w",
            zipfile.ZIP_DEFLATED,
        ) as zf:
            assert add_agent_workspaces(
                zf,
                [
                    (
                        "agent",
                        SimpleNamespace(workspace_dir=str(workspace)),
                    ),
                ],
            )
    finally:
        store.close()

    with zipfile.ZipFile(archive_path, "r") as zf:
        names = set(zf.namelist())
        archived_filename = (
            f"state/events.db"
            if location in (f"relative", f"absolute")
            else f"history-2.db"
        )
        db_entry = f"data/workspaces/agent/{archived_filename}"
        archived_config = json.loads(
            zf.read(f"data/workspaces/agent/agent.json"),
        )
        assert (
            archived_config[f"running"][f"light_context_config"][
                f"scroll_config"
            ][f"db_filename"]
            == archived_filename
        )
        assert (workspace / f"agent.json").read_text(
            encoding=f"utf-8",
        ) == live_config
        assert len(names) == len(zf.namelist())
        if location in (f"external", f"parent", f"symlink"):
            assert zf.read(f"data/workspaces/agent/history.db") == (
                b"unrelated file"
            )
        destination = tmp_path / f"restored-workspace"
        restore._stage_agents(
            zf,
            [f"agent"],
            {f"agent"},
            {f"agent": (destination, True)},
            [],
            {},
            [],
        )
        assert db_entry + "-wal" not in names
        assert db_entry + "-shm" not in names
        restored = (
            destination.with_name(f"{destination.name}.restore_tmp")
            / archived_filename
        )

    conn = sqlite3.connect(restored)
    try:
        assert conn.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert (
            conn.execute(
                "SELECT content FROM conversation_history",
            ).fetchone()[0]
            == "durable row"
        )
    finally:
        conn.close()


def test_workspace_backup_fails_when_history_is_invalid(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "agent.json").write_text(
        _agent_json(),
        encoding="utf-8",
    )
    (workspace / "history.db").write_bytes(b"not sqlite")

    with zipfile.ZipFile(io.BytesIO(), "w") as zf:
        with pytest.raises(sqlite3.DatabaseError):
            add_agent_workspaces(
                zf,
                [
                    (
                        "agent",
                        SimpleNamespace(workspace_dir=str(workspace)),
                    ),
                ],
            )


def test_workspace_backup_relocates_missing_external_history(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "agent.json").write_text(
        _agent_json("../history.db"),
        encoding="utf-8",
    )

    with zipfile.ZipFile(io.BytesIO(), f"w") as zf:
        assert add_agent_workspaces(
            zf,
            [(f"agent", SimpleNamespace(workspace_dir=str(workspace)))],
        )
        data = json.loads(zf.read(f"data/workspaces/agent/agent.json"))
        assert (
            data[f"running"][f"light_context_config"][f"scroll_config"][
                f"db_filename"
            ]
            == f"history.db"
        )
        assert not (tmp_path / f"history.db").exists()


def test_restore_rejects_invalid_history_before_commit(
    tmp_path: Path,
) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr(
            "data/workspaces/agent/agent.json",
            _agent_json(),
        )
        zf.writestr(
            "data/workspaces/agent/history.db",
            b"not sqlite",
        )
    buffer.seek(0)

    destination = tmp_path / "workspace"
    staged_dirs: list[Path] = []
    with zipfile.ZipFile(buffer, "r") as zf:
        with pytest.raises(BackupValidationError) as exc_info:
            restore._stage_agents(
                zf,
                ["agent"],
                {"agent"},
                {"agent": (destination, True)},
                staged_dirs,
                {},
                [],
            )

    assert exc_info.value.code == "history_database_invalid"
    assert not staged_dirs
    assert not destination.with_name(
        destination.name + ".restore_tmp",
    ).exists()


@pytest.mark.parametrize(f"absolute", [False, True])
def test_restore_rejects_history_path_escape_before_commit(
    tmp_path: Path,
    absolute: bool,
) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr(
            "data/workspaces/agent/agent.json",
            _agent_json(
                str(tmp_path / f"history.db")
                if absolute
                else f"../history.db",
            ),
        )
    buffer.seek(0)

    destination = tmp_path / "workspace"
    staged_dirs: list[Path] = []
    with zipfile.ZipFile(buffer, "r") as zf:
        with pytest.raises(BackupValidationError) as exc_info:
            restore._stage_agents(
                zf,
                ["agent"],
                {"agent"},
                {"agent": (destination, True)},
                staged_dirs,
                {},
                [],
            )

    assert exc_info.value.code == "history_database_path_invalid"
    assert not staged_dirs
    assert not destination.with_name(
        destination.name + ".restore_tmp",
    ).exists()

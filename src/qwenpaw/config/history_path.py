# -*- coding: utf-8 -*-
"""Canonical, workspace-bounded paths for Scroll conversation history."""
from __future__ import annotations

from pathlib import Path, PurePosixPath, PureWindowsPath

DEFAULT_HISTORY_DB_FILENAME = "history.db"


def migrate_history_db_path(data: object, workspace: str | Path) -> bool:
    """Relativize legacy absolute paths without changing the target DB."""
    config = data
    for key in (f"running", f"light_context_config", f"scroll_config"):
        if not isinstance(config, dict):
            return False
        config = config.get(key)
    if not isinstance(config, dict):
        return False
    filename = config.get(f"db_filename")
    if not isinstance(filename, str) or not Path(filename).is_absolute():
        return False
    root = Path(workspace).expanduser().resolve()
    target = Path(filename).resolve()
    if not target.is_relative_to(root):
        raise ValueError(
            f"history db_filename {filename!r} is outside the agent "
            f"workspace {str(root)!r}; move the history database into "
            f"the workspace and update db_filename before upgrading",
        )
    config[f"db_filename"] = normalize_history_db_filename(
        target.relative_to(root).as_posix(),
    )
    return True


def normalize_history_db_filename(value: str) -> str:
    """Validate and normalize a workspace-relative history DB filename."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("history db_filename must be a non-empty path")

    raw = value.strip()
    windows_path = PureWindowsPath(raw)
    posix_path = PurePosixPath(raw.replace("\\", "/"))
    if (
        raw.startswith("~")
        or posix_path.is_absolute()
        or windows_path.is_absolute()
        or bool(windows_path.drive)
    ):
        raise ValueError(
            "history db_filename must be relative to the agent workspace",
        )

    parts = posix_path.parts
    if not parts or any(part == ".." for part in parts):
        raise ValueError(
            "history db_filename must not escape the agent workspace",
        )
    return PurePosixPath(*parts).as_posix()


def resolve_history_db_path(
    workspace: str | Path,
    db_filename: str,
) -> Path:
    """Resolve a validated history path and reject symlink escapes."""
    root = Path(workspace).expanduser().resolve()
    filename = normalize_history_db_filename(db_filename)
    candidate = (root / filename).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError(
            "history db_filename resolves outside the agent workspace",
        )
    return candidate

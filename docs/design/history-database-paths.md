# History database paths

Approved scope: accept native absolute paths, workspace-relative paths (including parent traversal), home expansion, and symlinks without moving the live database or migrating the live configuration. Remove the absolute-to-relative migration introduced by this PR.

Backups explicitly snapshot the configured SQLite database, including WAL content. Archive configuration points to a workspace-relative snapshot; external databases use an unused filename to preserve unrelated workspace files. Restore validates that archive history remains inside the staged workspace and never follows an archive configuration to an external database.

## Checklist

- [x] Agree on behavior and inspect existing implementation.
- [x] Simplify runtime path handling and remove migration.
- [x] Make backups portable for internal and external databases.
- [x] Preserve restore containment.
- [x] Update existing tests and verify in QwenPaw environment.
- [x] Run changed-file checks and review final diff.

## Verification

QwenPaw conda environment on macOS: 1,245 existing config, backup, and context tests passed (with updated parameterized coverage). Changed-file pre-commit and `git diff --check` passed. Windows and Linux execution was not available locally. No new test files or runtime migration layers were introduced.

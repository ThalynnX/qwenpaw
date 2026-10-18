# -*- coding: utf-8 -*-
"""Regression coverage for skill ZIPs made by Chinese Windows archivers."""
# pylint: disable=protected-access,redefined-outer-name

import io
import shutil
import struct
import zipfile
import zlib

import pytest

from qwenpaw.agents.skill_system import store
from qwenpaw.exceptions import SkillsError


SKILL_MD = """---
name: demo
description: ZIP filename regression
---
Read [the guide](references/说明.txt).
"""


class LegacyZipInfo(zipfile.ZipInfo):
    """Write actual legacy filename bytes in both ZIP headers."""

    def __init__(self, filename, encoding="gbk", create_system=0):
        super().__init__(filename)
        self.encoding = encoding
        self.create_system = create_system

    def _encodeFilenameFlags(self):
        return self.filename.encode(self.encoding), self.flag_bits & ~0x800


def _unicode_path_extra(raw_name, unicode_name, *, valid_crc=True):
    checksum = zlib.crc32(raw_name)
    if not valid_crc:
        checksum ^= 1
    value = struct.pack("<BI", 1, checksum) + unicode_name.encode("utf-8")
    return struct.pack("<HH", 0x7075, len(value)) + value


def _archive(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for info, content in entries:
            archive.writestr(info, content)
    return buffer.getvalue()


def test_import_gbk_skill_preserves_referenced_files():
    """Run the same extraction entry point used by both skill upload APIs."""
    data = _archive(
        [
            (LegacyZipInfo("中文技能/SKILL.md"), SKILL_MD),
            (LegacyZipInfo("中文技能/references/说明.txt"), "reference text"),
            # GBK 0x81 0x5c is one character, not a path separator.
            (LegacyZipInfo("中文技能/乗.txt"), "backslash trail byte"),
            (LegacyZipInfo("中文技能/空目录/"), ""),
        ],
    )
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert not any(info.flag_bits & 0x800 for info in archive.infolist())
    extracted, found = store.extract_zip_skills(data)
    try:
        assert found == [(extracted / "中文技能", "demo")]
        skill_dir = found[0][0]
        assert (skill_dir / "references/说明.txt").read_text() == (
            "reference text"
        )
        assert (skill_dir / "乗.txt").read_text() == "backslash trail byte"
        assert (skill_dir / "空目录").is_dir()
    finally:
        shutil.rmtree(extracted)


def test_mixed_utf8_gbk_and_cp437_names(tmp_path):
    utf8 = zipfile.ZipInfo("中文.txt")
    utf8.extra = _unicode_path_extra(
        "中文.txt".encode("utf-8"),
        "ignored.txt",
    )
    data = _archive(
        [
            (utf8, "utf8"),
            (LegacyZipInfo("说明.txt"), "gbk"),
            (LegacyZipInfo("café.txt", "cp437"), "cp437"),
            (LegacyZipInfo("README.txt", "cp437"), "ascii"),
        ],
    )
    store._extract_and_validate_zip(data, tmp_path)
    assert {p.name: p.read_text() for p in tmp_path.iterdir()} == {
        "中文.txt": "utf8",
        "说明.txt": "gbk",
        "café.txt": "cp437",
        "README.txt": "ascii",
    }


def test_non_windows_cp437_names_are_not_guessed(tmp_path):
    name = "╬─.txt"
    data = _archive([(LegacyZipInfo(name, "cp437", 3), "cp437")])
    store._extract_and_validate_zip(data, tmp_path)
    assert (tmp_path / name).read_text() == "cp437"


def test_decoded_names_keep_windows_filename_sanitization(
    tmp_path,
    monkeypatch,
):
    data = _archive([(LegacyZipInfo("中文:说明?.txt"), "windows name")])
    # Exercise ZipFile's Windows filename sanitation on a single-component
    # path without changing the host filesystem or pathlib implementation.
    monkeypatch.setattr(zipfile.os.path, "sep", "\\")
    store._extract_and_validate_zip(data, tmp_path)
    assert (tmp_path / "中文_说明_.txt").read_text() == "windows name"


def test_unicode_path_metadata_overrides_legacy_name(tmp_path):
    info = LegacyZipInfo("说明.txt")
    info.extra = _unicode_path_extra(
        info.filename.encode("gbk"),
        "日本語/ガイド.txt",
    )
    store._extract_and_validate_zip(_archive([(info, "guide")]), tmp_path)
    assert (tmp_path / "日本語/ガイド.txt").read_text() == "guide"


@pytest.mark.parametrize("invalid", ["crc", "version", "utf8"])
def test_invalid_unicode_metadata_keeps_original_name(tmp_path, invalid):
    info = LegacyZipInfo("说明.txt")
    raw_name = info.filename.encode("gbk")
    extra = _unicode_path_extra(
        raw_name,
        "wrong.txt",
        valid_crc=invalid != "crc",
    )
    if invalid == "version":
        extra = extra[:4] + b"\x02" + extra[5:]
    elif invalid == "utf8":
        extra = extra[:9] + b"\xff" + extra[10:]
    info.extra = extra
    store._extract_and_validate_zip(_archive([(info, "original")]), tmp_path)
    assert (tmp_path / raw_name.decode("cp437")).read_text() == "original"


@pytest.mark.parametrize(
    "unsafe_name",
    ["../outside.txt", "/outside.txt", r"..\outside.txt", r"C:\outside.txt"],
)
def test_unicode_path_traversal_rejected_before_any_extraction(
    tmp_path,
    unsafe_name,
):
    info = LegacyZipInfo("safe.txt", "cp437")
    info.extra = _unicode_path_extra(b"safe.txt", unsafe_name)
    data = _archive([("first.txt", "must not be extracted"), (info, "unsafe")])
    with pytest.raises(SkillsError, match="Unsafe path"):
        store._extract_and_validate_zip(data, tmp_path)
    assert not list(tmp_path.iterdir())


def test_gbk_windows_path_traversal_rejected_before_any_extraction(tmp_path):
    data = _archive(
        [
            ("first.txt", "must not be extracted"),
            (LegacyZipInfo(r"中文\..\..\outside.txt"), "unsafe"),
        ],
    )
    with pytest.raises(SkillsError, match="Unsafe path"):
        store._extract_and_validate_zip(data, tmp_path)
    assert not list(tmp_path.iterdir())


def test_symlink_rejected_before_any_extraction(tmp_path):
    info = LegacyZipInfo("说明.txt")
    info.external_attr = 0o120777 << 16
    data = _archive([("first.txt", "safe"), (info, "../outside.txt")])
    with pytest.raises(SkillsError, match="Symlink not allowed"):
        store._extract_and_validate_zip(data, tmp_path)
    assert not list(tmp_path.iterdir())

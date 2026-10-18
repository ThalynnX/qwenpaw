# -*- coding: utf-8 -*-
"""Recover legacy Windows skill ZIP names without changing read metadata."""

import struct
import zipfile
import zlib


def _unicode_path_name(info: zipfile.ZipInfo, raw_name: bytes) -> str | None:
    """Read a Unicode Path field, or return None if the field is absent."""
    offset = 0
    while offset + 4 <= len(info.extra):
        field_id, size = struct.unpack_from("<HH", info.extra, offset)
        offset += 4
        value = info.extra[offset : offset + size]
        offset += size
        if field_id != 0x7075:
            continue
        # Info-ZIP Unicode Path: version, CRC32 of the legacy filename,
        # then the UTF-8 name. Do not guess around invalid Unicode metadata.
        if (
            len(value) != size
            or len(value) < 6
            or value[0] != 1
            or struct.unpack_from("<I", value, 1)[0] != zlib.crc32(raw_name)
        ):
            return info.orig_filename
        try:
            return value[5:].decode("utf-8")
        except UnicodeDecodeError:
            return info.orig_filename
    return None


def zip_member_name(info: zipfile.ZipInfo) -> str:
    """Prefer declared Unicode; conservatively recover Chinese Windows names.

    Flagless ZIP filenames have no reliable encoding declaration. Only guess
    GBK for DOS/Windows entries whose CP437 interpretation contains box-drawing
    characters and whose GBK interpretation contains CJK text. Ordinary ASCII,
    accented CP437 and non-Windows entries keep their original names. This is
    deliberately not a universal encoding detector: use UTF-8 ZIPs for names
    that remain ambiguous.

    Keep ``info`` unchanged: ZipFile needs its original filename to verify the
    local header when reading a member.
    """
    original = info.orig_filename
    if info.flag_bits & 0x800:
        return original

    raw_name = original.encode("cp437")
    unicode_name = _unicode_path_name(info, raw_name)
    if unicode_name is not None:
        return unicode_name

    if info.create_system != 0 or not any(
        "\u2500" <= char <= "\u259f" for char in original
    ):
        return original
    try:
        decoded = raw_name.decode("gbk")
    except UnicodeDecodeError:
        return original
    if any("\u3400" <= char <= "\u9fff" for char in decoded):
        return decoded
    return original

#!/usr/bin/env python3
"""Developer ID derivation of the qualified darwin archive (DEVID-SIGN-V1, docs/release-signing.md).

The local signer and the tag-ref signing run share this verifier. CI never attests the signer's
bytes until `verify` proves they are the qualified archive plus a valid Developer ID signature:
every non-Mach-O member is byte-identical, each Mach-O is byte-identical up to its code
signature, and only the darwin digests of the release index change.

  prepare  validate the qualified archive with the installer's parser and extract its Mach-O
           members, each with its pinned code-signing identifier
  repack   rebuild the archive around signed Mach-O members, with an updated release manifest
  verify   prove the derivation, check the signature, team, hardened runtime, timestamp,
           entitlements and notarization, optionally execute it, then write the final index
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "installer"))
import install  # noqa: E402  (the installer's own fail-closed archive parser)

PLATFORM = "darwin-arm64-none"
TEAM_ID = "XGL9CXRCT5"
AUTHORITY = f"Developer ID Application: Joshua Nowak ({TEAM_ID})"
# Every Mach-O shipped in the darwin archive has a stable identifier, so launchd's launch
# requirement (team + identifier) survives a release. An unlisted Mach-O is refused.
IDENTIFIERS = {"bin/omp-kit": "ai.zeststream.omp-kit"}
MANIFEST = "release-manifest.json"
MACHO_MAGICS = {bytes.fromhex(value) for value in (
    "cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")}
MH_MAGIC_64_LE = bytes.fromhex("cffaedfe")
LC_SEGMENT_64 = 0x19
LC_CODE_SIGNATURE = 0x1D


class Refused(Exception):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def is_macho(data: bytes) -> bool:
    return data[:4] in MACHO_MAGICS


def canonical_json(value: Any, *, sort_keys: bool) -> bytes:
    return json.dumps(value, sort_keys=sort_keys, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"


def installer_check(archive: Path, index: Path, version: str) -> tuple[dict[str, Any], dict[str, tuple[str, bytes]], bytes]:
    """The installer's own validation: index identity, archive digest, USTAR safety, manifest and inventory."""
    try:
        asset = install.index_asset(str(index), version, PLATFORM)
        members, manifest = install.archive_members(str(archive), asset)
        install.verify_manifest(members, manifest, version)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        raise Refused(f"installer verification failed for {archive.name}: {error}") from error
    return asset, members, members[MANIFEST][1]


def tar_entries(data: bytes) -> tuple[list[tuple[bytes, str, bytes]], bytes]:
    """(header, name, body) per member in archive order, plus the terminator; headers are kept verbatim."""
    entries: list[tuple[bytes, str, bytes]] = []
    cursor = 0
    while cursor + 512 <= len(data):
        header = data[cursor:cursor + 512]
        if header == bytes(512):
            return entries, data[cursor:]
        size = int(header[124:136].split(b"\0", 1)[0].strip(), 8)
        name = header[:100].split(b"\0", 1)[0].decode("utf-8")
        prefix = header[345:500].split(b"\0", 1)[0].decode("utf-8")
        name = (prefix + "/" if prefix else "") + name
        if header[156:157] == b"5":
            name = name[:-1]
        entries.append((header, name, data[cursor + 512:cursor + 512 + size]))
        cursor += 512 + (size + 511) // 512 * 512
    raise Refused("archive has no USTAR terminator")


def entries_for(archive: Path, members: dict[str, tuple[str, bytes]]) -> tuple[list[tuple[bytes, str, bytes]], bytes]:
    entries, trailer = tar_entries(archive.read_bytes())
    if [name for _, name, _ in entries] != list(members) or any(body != members[name][1] for _, name, body in entries):
        raise Refused("archive members differ from the installer's parse")
    return entries, trailer


def header_with_size(header: bytes, size: int) -> bytes:
    """Rewrite only the size and checksum fields, in scripts/package-release.ts's exact USTAR format."""
    block = bytearray(header)
    digits = format(size, "o")
    if len(digits) >= 12:
        raise Refused("USTAR_SIZE_UNSUPPORTED")
    block[124:136] = (digits.rjust(11, "0") + "\0").encode("ascii")
    block[148:156] = b" " * 8
    block[148:156] = (format(sum(block), "o").rjust(7, "0") + "\0").encode("ascii")
    return bytes(block)


def header_identity(header: bytes) -> bytes:
    """A header with its size and checksum masked: name, mode, owner, time, type and magic must not change."""
    return header[:124] + bytes(12) + header[136:148] + bytes(8) + header[156:]


def derived_manifest(original: bytes, digests: dict[str, str]) -> bytes:
    manifest = json.loads(original)
    if canonical_json(manifest, sort_keys=False) != original:
        raise Refused("release manifest serialization is not reproducible")
    entries = {entry["path"]: entry for entry in manifest["files"]}
    for path, digest in digests.items():
        if path not in entries:
            raise Refused(f"signed member is absent from the release manifest: {path}")
        entries[path]["sha256"] = digest
    return canonical_json(manifest, sort_keys=False)


def derived_index(original: bytes, archive_sha256: str, manifest_sha256: str) -> bytes:
    index = json.loads(original)
    if canonical_json(index, sort_keys=True) != original:
        raise Refused("release index serialization is not reproducible")
    asset = index["assets"][PLATFORM]
    asset["sha256"], asset["manifest_sha256"] = archive_sha256, manifest_sha256
    return canonical_json(index, sort_keys=True)


def macho_code(data: bytes, path: str) -> bytes:
    """The bytes before a thin 64-bit Mach-O's code signature, with only the signature-sized fields masked.

    Re-signing changes nothing before LC_CODE_SIGNATURE's dataoff except __LINKEDIT's vmsize/filesize
    and the signature's datasize (measured on v0.2.52: after `codesign --remove-signature` the ad hoc and
    Developer ID copies differ only in __LINKEDIT vmsize). The signature must end the file."""
    if data[:4] != MH_MAGIC_64_LE:
        raise Refused(f"{path}: only thin little-endian 64-bit Mach-O is supported")
    ncmds, sizeofcmds = struct.unpack_from("<II", data, 16)
    cursor, end = 32, 32 + sizeofcmds
    if end > len(data):
        raise Refused(f"{path}: load commands exceed the file")
    masks: list[tuple[int, int]] = []
    signature: tuple[int, int] | None = None
    linkedit: tuple[int, int] | None = None
    for _ in range(ncmds):
        if cursor + 8 > end:
            raise Refused(f"{path}: truncated load command")
        command, size = struct.unpack_from("<II", data, cursor)
        if size < 8 or cursor + size > end:
            raise Refused(f"{path}: malformed load command")
        if command == LC_CODE_SIGNATURE:
            if signature is not None or size != 16:
                raise Refused(f"{path}: ambiguous code signature command")
            signature = struct.unpack_from("<II", data, cursor + 8)
            masks.append((cursor + 12, 4))
        elif command == LC_SEGMENT_64 and data[cursor + 8:cursor + 24].rstrip(b"\0") == b"__LINKEDIT":
            if linkedit is not None:
                raise Refused(f"{path}: duplicate __LINKEDIT")
            fileoff, filesize = struct.unpack_from("<QQ", data, cursor + 40)
            linkedit = (fileoff, filesize)
            masks += [(cursor + 32, 8), (cursor + 48, 8)]
        cursor += size
    if cursor != end or signature is None or linkedit is None:
        raise Refused(f"{path}: no code signature or __LINKEDIT")
    dataoff, datasize = signature
    if dataoff + datasize != len(data) or sum(linkedit) != len(data) or dataoff < end:
        raise Refused(f"{path}: the code signature does not end the file")
    code = bytearray(data[:dataoff])
    for offset, width in masks:
        code[offset:offset + width] = bytes(width)
    return bytes(code)


def _codesign_details(binary: Path) -> dict[str, list[str]]:
    result = subprocess.run(["codesign", "-d", "--verbose=4", str(binary)], capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise Refused(f"{binary.name}: codesign -d failed: {result.stderr.strip()}")
    details: dict[str, list[str]] = {}
    for line in (result.stderr + result.stdout).splitlines():
        key, separator, value = line.partition("=")
        if separator:
            details.setdefault(key.strip(), []).append(value.strip())
    return details


def check_signature(binary: Path, path: str, entitlements: Path, *, notarized: bool) -> dict[str, str]:
    if shutil.which("codesign") is None or shutil.which("spctl") is None:
        raise Refused("codesign/spctl unavailable: Developer ID verification needs macOS (use --structural-only for structure)")
    strict = subprocess.run(["codesign", "--verify", "--strict", "--verbose=2", str(binary)], capture_output=True, text=True, timeout=300)
    if strict.returncode:
        raise Refused(f"{path}: codesign --verify --strict failed: {strict.stderr.strip()}")
    details = _codesign_details(binary)
    first = lambda key: (details.get(key) or [""])[0]  # noqa: E731
    code_directory = first("CodeDirectory v")
    if first("Identifier") != IDENTIFIERS[path]:
        raise Refused(f"{path}: Identifier={first('Identifier')} is not {IDENTIFIERS[path]}")
    if first("TeamIdentifier") != TEAM_ID:
        raise Refused(f"{path}: TeamIdentifier={first('TeamIdentifier')} is not {TEAM_ID}")
    if first("Authority") != AUTHORITY:
        raise Refused(f"{path}: leaf Authority={first('Authority')} is not {AUTHORITY}")
    if "(runtime" not in code_directory and ",runtime" not in code_directory:
        raise Refused(f"{path}: hardened runtime flag missing ({code_directory})")
    if not first("Timestamp"):
        raise Refused(f"{path}: no secure timestamp")
    shown = subprocess.run(["codesign", "-d", "--entitlements", "-", "--xml", str(binary)], capture_output=True, timeout=120)
    try:
        actual = plistlib.loads(shown.stdout) if shown.returncode == 0 and shown.stdout.strip() else None
    except plistlib.InvalidFileException:
        actual = None
    if actual != plistlib.loads(entitlements.read_bytes()):
        raise Refused(f"{path}: entitlements differ from {entitlements}")
    result = {"identifier": first("Identifier"), "team": first("TeamIdentifier"), "cdhash": first("CDHash")}
    if notarized:
        # `--type execute` rejects every bare Mach-O ("does not seem to be an app"); the primary-signature
        # context assesses the notarization ticket by cdhash, online.
        assess = subprocess.run(["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "-vv", str(binary)],
                                capture_output=True, text=True, timeout=300)
        if assess.returncode or "source=Notarized Developer ID" not in assess.stderr:
            raise Refused(f"{path}: Gatekeeper does not report Notarized Developer ID: {assess.stderr.strip()}")
        result["gatekeeper"] = "Notarized Developer ID"
    return result


def execute(binary: Path, version: str) -> None:
    with tempfile.TemporaryDirectory(prefix="devid-exec-") as home:
        env = {"HOME": home, "TMPDIR": home, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "NO_COLOR": "1"}
        result = subprocess.run([str(binary), "--version"], capture_output=True, text=True, env=env, cwd=home, timeout=120)
    if result.returncode in (-9, 137):
        raise Refused(f"{binary.name} was killed on launch (rc {result.returncode}; code-signing enforcement)")
    if result.returncode or result.stdout.strip() != f"omp-kit {version}":
        raise Refused(f"{binary.name} --version: rc {result.returncode}, stdout {result.stdout.strip()!r}, stderr {result.stderr.strip()[-400:]!r}")


def signed_members(members: dict[str, tuple[str, bytes]]) -> list[str]:
    paths = [name for name, (kind, body) in members.items() if kind == "file" and is_macho(body)]
    unknown = sorted(set(paths) - set(IDENTIFIERS))
    if unknown:
        raise Refused(f"Mach-O members without a pinned identifier: {', '.join(unknown)}")
    if not paths:
        raise Refused("the darwin archive has no Mach-O member to sign")
    return paths


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    _, members, _ = installer_check(Path(args.archive), Path(args.index), args.version)
    out = Path(args.out)
    plan = []
    for path in signed_members(members):
        target = out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "xb") as stream:
            stream.write(members[path][1])
        target.chmod(0o755)
        plan.append({"path": path, "identifier": IDENTIFIERS[path], "sha256": sha256(members[path][1])})
    return {"version": args.version, "platform": PLATFORM, "members": plan}


def repack(args: argparse.Namespace) -> dict[str, Any]:
    archive = Path(args.archive)
    _, members, manifest = installer_check(archive, Path(args.index), args.version)
    entries, trailer = entries_for(archive, members)
    signed = {path: (Path(args.signed_dir) / path).read_bytes() for path in signed_members(members)}
    new_manifest = derived_manifest(manifest, {path: sha256(body) for path, body in signed.items()})
    output = bytearray()
    for header, name, body in entries:
        replacement = signed.get(name, new_manifest if name == MANIFEST else None)
        if replacement is not None:
            header, body = header_with_size(header, len(replacement)), replacement
        output += header + body + bytes((512 - len(body) % 512) % 512)
    output += trailer
    with open(args.out_archive, "xb") as stream:
        stream.write(output)
    index = derived_index(Path(args.index).read_bytes(), sha256(bytes(output)), sha256(new_manifest))
    with open(args.out_index, "xb") as stream:
        stream.write(index)
    return {"archive_sha256": sha256(bytes(output)), "manifest_sha256": sha256(new_manifest)}


def verify(args: argparse.Namespace) -> dict[str, Any]:
    qualified_archive, signed_archive = Path(args.qualified_archive), Path(args.signed_archive)
    qualified_index = Path(args.qualified_index).read_bytes()
    _, members, manifest = installer_check(qualified_archive, Path(args.qualified_index), args.version)
    macho = signed_members(members)
    signed_bytes = signed_archive.read_bytes()
    signed_sha = sha256(signed_bytes)
    if args.signed_sha256 is not None and signed_sha != args.signed_sha256:
        raise Refused(f"signed archive SHA-256 {signed_sha} is not the dispatched {args.signed_sha256}")
    qualified_entries, qualified_trailer = entries_for(qualified_archive, members)
    signed_entries, signed_trailer = tar_entries(signed_bytes)
    if [name for _, name, _ in signed_entries] != [name for _, name, _ in qualified_entries] or signed_trailer != qualified_trailer:
        raise Refused("signed archive member list, order or terminator differs from the qualified archive")
    digests: dict[str, str] = {}
    signed_manifest = b""
    for (q_header, name, q_body), (s_header, _, s_body) in zip(qualified_entries, signed_entries):
        if name in macho or name == MANIFEST:
            if header_identity(q_header) != header_identity(s_header):
                raise Refused(f"{name}: USTAR header differs beyond size and checksum")
            if name == MANIFEST:
                signed_manifest = s_body
            else:
                if macho_code(q_body, name) != macho_code(s_body, name):
                    raise Refused(f"{name}: code before the signature differs from the qualified binary")
                digests[name] = sha256(s_body)
        elif q_header != s_header or q_body != s_body:
            raise Refused(f"{name}: differs from the qualified archive")
    if signed_manifest != derived_manifest(manifest, digests):
        raise Refused("release manifest differs beyond the signed Mach-O digests")
    final_index = derived_index(qualified_index, signed_sha, sha256(signed_manifest))
    with tempfile.TemporaryDirectory(prefix="devid-verify-") as work:
        index_path = Path(work) / "release-index.json"
        index_path.write_bytes(final_index)
        _, signed_view, _ = installer_check(signed_archive, index_path, args.version)
        checks: dict[str, Any] = {}
        if not args.structural_only:
            # The installer's own extraction: the binary reads its version from the release tree beside it. Resolve the
            # scratch path first: macOS TMPDIR lives under /var, a symlink the installer refuses as an ancestor.
            release = install._extract_members(signed_view, Path(work).resolve())
            for name in macho:
                checks[name] = check_signature(release / name, name, Path(args.entitlements), notarized=not args.no_notarization)
                if args.execute and name == "bin/omp-kit":
                    execute(release / name, args.version)
                    checks[name]["executed"] = f"omp-kit {args.version}"
    if args.index_out:
        with open(args.index_out, "xb") as stream:
            stream.write(final_index)
    return {"verified": "structural" if args.structural_only else "developer-id", "version": args.version,
            "archive_sha256": signed_sha, "manifest_sha256": sha256(signed_manifest), "index_sha256": sha256(final_index),
            "signed": checks or sorted(digests)}


def keychain_unlock(args: argparse.Namespace) -> dict[str, Any]:
    """Unlock the dedicated signing keychain in-process (Security.framework), so its password never reaches argv,
    stdout or a log. The password source is the operator's existing file (mode 0600), read like `$(cat file)`."""
    import ctypes
    secret = Path(args.password_file)
    if secret.is_symlink() or not secret.is_file() or secret.stat().st_mode & 0o077:
        raise Refused(f"{secret} must be a regular file readable only by its owner")
    password = secret.read_bytes().rstrip(b"\n")
    if not password:
        raise Refused(f"{secret} is empty")
    security = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/Security.framework/Security")
    corefoundation = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    security.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    security.SecKeychainUnlock.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_bool]
    corefoundation.CFRelease.argtypes = [ctypes.c_void_p]
    keychain = ctypes.c_void_p()
    status = security.SecKeychainOpen(str(args.keychain).encode(), ctypes.byref(keychain))
    if status or not keychain.value:
        raise Refused(f"cannot open keychain {args.keychain} (OSStatus {status})")
    try:
        status = security.SecKeychainUnlock(keychain, len(password), password, True)
    finally:
        corefoundation.CFRelease(keychain)
    if status:
        raise Refused(f"keychain unlock failed for {args.keychain} (OSStatus {status})")
    return {"unlocked": str(args.keychain)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "repack"):
        command = commands.add_parser(name)
        command.add_argument("--archive", required=True)
        command.add_argument("--index", required=True)
        command.add_argument("--version", required=True)
    commands.choices["prepare"].add_argument("--out", required=True)
    commands.choices["repack"].add_argument("--signed-dir", required=True)
    commands.choices["repack"].add_argument("--out-archive", required=True)
    commands.choices["repack"].add_argument("--out-index", required=True)
    check = commands.add_parser("verify")
    check.add_argument("--qualified-archive", required=True)
    check.add_argument("--qualified-index", required=True)
    check.add_argument("--signed-archive", required=True)
    check.add_argument("--signed-sha256")
    check.add_argument("--version", required=True)
    check.add_argument("--entitlements", default=str(ROOT / "packaging/macos/omp-kit.entitlements.plist"))
    check.add_argument("--index-out")
    check.add_argument("--structural-only", action="store_true", help="derivation only; no codesign, Gatekeeper or execution")
    check.add_argument("--no-notarization", action="store_true", help="skip the Gatekeeper notarization assessment")
    check.add_argument("--execute", action="store_true", help="run bin/omp-kit --version in an isolated HOME")
    unlock = commands.add_parser("keychain-unlock")
    unlock.add_argument("--keychain", required=True)
    unlock.add_argument("--password-file", required=True)
    args = parser.parse_args(argv)
    try:
        result = {"prepare": prepare, "repack": repack, "verify": verify, "keychain-unlock": keychain_unlock}[args.command](args)
    except (Refused, FileExistsError, FileNotFoundError, KeyError, ValueError, UnicodeDecodeError, struct.error) as error:
        print(f"devid-release: refused: {error}", file=sys.stderr)
        return 4
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())

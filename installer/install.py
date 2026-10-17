#!/usr/bin/env python3
"""Standalone archive verifier for install.sh; stdlib only, no candidate code before byte validation."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zlib
from typing import NoReturn

MAX_ARCHIVE = 256 * 1024 * 1024
SHA = re.compile(r"[0-9a-f]{64}\Z")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\Z")

def valid_version(value):
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        return False
    parts = value.split("-", 1)
    return len(parts) == 1 or all(not item.isdigit() or item == "0" or not item.startswith("0")
                                  for item in parts[1].split("."))


def refuse(reason: str) -> NoReturn:
    raise ValueError(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def object_no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            refuse("duplicate JSON key: " + key)
        result[key] = value
    return result


def parse_json(data):
    return json.loads(data, object_pairs_hook=object_no_duplicates)


def safe_path(name):
    return (isinstance(name, str) and name and not name.startswith("/")
            and "\\" not in name and "\0" not in name
            and all(segment not in ("", ".", "..") for segment in name.split("/")))


def index_asset(index_path, version, platform):
    if not valid_version(version):
        refuse("invalid selected release version")
    if Path(index_path).stat().st_size > 1024 * 1024:
        refuse("release index too large")
    raw = Path(index_path).read_bytes()
    if len(raw) > 1024 * 1024:
        refuse("release index too large")
    index = parse_json(raw)
    if (not isinstance(index, dict) or set(index) != {"schema_version", "version", "source_tag", "assets"}
            or index["schema_version"] != 1 or index["version"] != version
            or index["source_tag"] != "v" + version or not isinstance(index["assets"], dict)):
        refuse("release index identity mismatch")
    for key, candidate in index["assets"].items():
        if (not isinstance(candidate, dict) or set(candidate) != {"os", "arch", "libc", "filename", "sha256", "manifest_sha256"}
                or key != "-".join(str(candidate[item]) for item in ("os", "arch", "libc"))
                or candidate["os"] not in ("darwin", "linux") or candidate["arch"] not in ("arm64", "x64")
                or candidate["libc"] != ("none" if candidate["os"] == "darwin" else "gnu")
                or not isinstance(candidate["filename"], str)
                or not re.fullmatch(r"[A-Za-z0-9_.-]+\.tar(?:\.gz)?", candidate["filename"])
                or not all(isinstance(candidate[field], str) and SHA.fullmatch(candidate[field])
                           for field in ("sha256", "manifest_sha256"))):
            refuse("invalid release asset")
    if platform not in index["assets"]:
        refuse("selected platform is absent from release index")
    return index["assets"][platform]


def archive_members(path, asset):
    if Path(path).stat().st_size > MAX_ARCHIVE:
        refuse("archive exceeds size limit")
    archive = Path(path).read_bytes()
    if sha(archive) != asset["sha256"]:
        refuse("archive SHA-256 mismatch or size limit")
    gz = asset["filename"].endswith(".gz")
    if gz != archive.startswith(b"\x1f\x8b"):
        refuse("archive compression does not match asset")
    if gz:
        decoder = zlib.decompressobj(31)
        archive = decoder.decompress(archive, MAX_ARCHIVE + 1)
        if len(archive) > MAX_ARCHIVE or not decoder.eof or decoder.unused_data:
            refuse("compressed archive exceeds limit or has trailing data")
        archive += decoder.flush(MAX_ARCHIVE + 1 - len(archive))
    members = {}
    cursor = 0
    finished = False
    while cursor + 512 <= len(archive):
        header = archive[cursor:cursor + 512]
        if header == bytes(512):
            finished = True
            break
        if header[257:263] != b"ustar\0":
            refuse("non-USTAR archive member")
        def octal(start, length):
            raw = header[start:start + length].split(b"\0", 1)[0].strip()
            if not raw or not re.fullmatch(b"[0-7]+", raw):
                refuse("invalid USTAR number")
            return int(raw, 8)
        size = octal(124, 12)
        check = octal(148, 8)
        if sum(header[:148]) + 8 * 32 + sum(header[156:]) != check:
            refuse("USTAR header checksum mismatch")
        try:
            name = header[:100].split(b"\0", 1)[0].decode("utf-8")
            prefix = header[345:500].split(b"\0", 1)[0].decode("utf-8")
        except UnicodeDecodeError:
            refuse("invalid USTAR member encoding")
        name = (prefix + "/" if prefix else "") + name
        kind = header[156:157]
        if kind not in (b"0", b"\0", b"5"):
            refuse("unsafe archive member type")
        if kind == b"5":
            if size != 0 or not name.endswith("/"):
                refuse("invalid directory member")
            name = name[:-1]
        if not safe_path(name) or name in members:
            refuse("unsafe or duplicate archive member name")
        cursor += 512
        if size > len(archive) - cursor:
            refuse("truncated archive member")
        members[name] = ("directory" if kind == b"5" else "file", archive[cursor:cursor + size])
        cursor += ((size + 511) // 512) * 512
    if not finished or len(archive) - cursor < 1024 or any(archive[cursor:]):
        refuse("invalid archive terminator")
    for name in members:
        parent = Path(name).parent
        while str(parent) != ".":
            if str(parent) in members and members[str(parent)][0] != "directory":
                refuse("archive file used as parent directory")
            parent = parent.parent
    raw_manifest = members.get("release-manifest.json")
    if not raw_manifest or raw_manifest[0] != "file" or len(raw_manifest[1]) > 4 * 1024 * 1024 or sha(raw_manifest[1]) != asset["manifest_sha256"]:
        refuse("release manifest SHA-256 mismatch")
    return members, parse_json(raw_manifest[1])


def verify_manifest(members, manifest, version):
    if (not isinstance(manifest, dict) or set(manifest) != {"schema_version", "version", "source_tag", "files"}
            or manifest["schema_version"] != 1 or manifest["version"] != version
            or manifest["source_tag"] != "v" + version or not isinstance(manifest["files"], list)):
        refuse("release manifest identity mismatch")
    expected = {}
    for entry in manifest["files"]:
        if (not isinstance(entry, dict) or set(entry) != {"path", "sha256"}
                or not safe_path(entry["path"]) or not isinstance(entry["sha256"], str)
                or not SHA.fullmatch(entry["sha256"]) or entry["path"] in expected):
            refuse("invalid manifest file entry")
        expected[entry["path"]] = entry["sha256"]
    if list(expected) != sorted(expected) or "bin/omp-kit" not in expected:
        refuse("manifest ordering or executable missing")
    actual = {name for name, (kind, _) in members.items() if kind == "file"}
    if actual != set(expected) | {"release-manifest.json"}:
        refuse("archive inventory differs from manifest")
    for name, digest in expected.items():
        if sha(members[name][1]) != digest:
            refuse("internal file SHA-256 mismatch: " + name)
    for name, (kind, _) in members.items():
        if kind == "directory" and not any(child.startswith(name + "/") for child in actual):
            refuse("unlisted empty release directory")


def download_attestation(archive):
    digest = sha(Path(archive).read_bytes())
    result = subprocess.run(
        ["gh", "api", "--hostname", "github.com",
         "repos/JYeswak/omp-kit-companion/attestations/sha256:" + digest,
         "--jq", ".attestations[].bundle | tojson"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if result.returncode != 0 or not result.stdout.strip() or len(result.stdout) > 16 * 1024 * 1024:
        refuse("KIT_ATTESTATION_BUNDLE_UNAVAILABLE: " + result.stderr.decode(errors="replace").strip()[-1000:])
    with open(str(archive) + ".sigstore.json", "xb") as output:
        output.write(result.stdout)


def verify_attestation(archive, version):
    """The installer and compiled updater share this fail-closed authority policy."""
    if not valid_version(version):
        refuse("KIT_ATTESTATION_SOURCE_UNVERIFIED")
    bundle = Path(str(archive) + ".sigstore.json")
    if bundle.is_symlink() or not bundle.is_file():
        refuse("KIT_ATTESTATION_BUNDLE_MISSING")
    if bundle.stat().st_size > 16 * 1024 * 1024:
        refuse("KIT_ATTESTATION_BUNDLE_INVALID")
    try:
        source = subprocess.run(
            ["gh", "api", "--hostname", "github.com",
             "repos/JYeswak/omp-kit-companion/commits/v" + version, "--jq", ".sha"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        digest = source.stdout.decode(errors="replace").strip()
        if source.returncode != 0 or len(digest) != 40 or any(c not in "0123456789abcdef" for c in digest):
            refuse("KIT_ATTESTATION_SOURCE_UNVERIFIED: " + source.stderr.decode(errors="replace").strip()[-1000:])
        # gh selects JSON-lines decoding by extension. Release siblings retain
        # .sigstore.json even when the authority returns both SBOM and SLSA bundles.
        raw = bundle.read_bytes()
        try:
            bundles = [parse_json(raw)]
        except json.JSONDecodeError:
            bundles = [parse_json(line) for line in raw.splitlines() if line.strip()]
        if not bundles or any(not isinstance(item, dict) for item in bundles):
            refuse("KIT_ATTESTATION_BUNDLE_INVALID")
        with tempfile.TemporaryDirectory(prefix="omp-kit-attestation-") as work:
            normalized = Path(work) / "bundle.jsonl"
            normalized.write_text("".join(json.dumps(item) + "\n" for item in bundles))
            result = subprocess.run(
                ["gh", "attestation", "verify", str(archive),
                 "--hostname", "github.com", "--repo", "JYeswak/omp-kit-companion",
                 "--bundle", str(normalized),
                 "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
                 "--signer-workflow", "JYeswak/omp-kit-companion/.github/workflows/release.yml",
                 "--source-digest", digest,
                 "--predicate-type", "https://slsa.dev/provenance/v1"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        refuse("KIT_ATTESTATION_VERIFIER_UNAVAILABLE: " + str(exc))
    if result.returncode != 0:
        refuse("KIT_ATTESTATION_UNVERIFIED: " + result.stderr.decode(errors="replace").strip()[-1000:])


def safe_directory(path):
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        refuse("unsafe installation directory: " + str(path))
    for parent in (path, *path.parents):
        if parent.is_symlink():
            refuse("symlinked installation ancestor: " + str(parent))


def _extract_members(members, parent):
    """Extract already validated bytes into a fresh child of a caller-owned directory."""
    safe_directory(parent)
    staging = Path(tempfile.mkdtemp(prefix=".omp-kit-stage-", dir=parent))
    try:
        for name in sorted((name for name, (kind, _) in members.items() if kind == "directory"), key=lambda n: (n.count("/"), n)):
            (staging / name).mkdir(mode=0o755)
        for name, (kind, data) in members.items():
            if kind != "file":
                continue
            dest = staging / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            dest.chmod(0o755 if name in ("bin/omp-kit", "scripts/receipt.py") or name.endswith(".sh") else 0o644)
    except BaseException:
        shutil.rmtree(staging)
        raise
    return staging


def install(index_path, version, platform, archive, prefix, dry_run):
    asset = index_asset(index_path, version, platform)
    if Path(archive).name != asset["filename"]:
        refuse("archive filename differs from selected index asset")
    # Retain one private byte snapshot across inspection and external authority
    # verification; the caller's pathname is not a stable archive identity.
    with tempfile.TemporaryDirectory(prefix="omp-kit-archive-") as work:
        snapshot = Path(work) / asset["filename"]
        with open(archive, "rb") as source:
            data = source.read(MAX_ARCHIVE + 1)
        if len(data) > MAX_ARCHIVE:
            refuse("archive exceeds size limit")
        snapshot.write_bytes(data)
        bundle = Path(str(archive) + ".sigstore.json")
        if bundle.is_symlink() or not bundle.is_file():
            refuse("KIT_ATTESTATION_BUNDLE_MISSING")
        with bundle.open("rb") as source:
            bundle_data = source.read(16 * 1024 * 1024 + 1)
        if len(bundle_data) > 16 * 1024 * 1024:
            refuse("KIT_ATTESTATION_BUNDLE_INVALID")
        Path(str(snapshot) + ".sigstore.json").write_bytes(bundle_data)
        members, manifest = archive_members(snapshot, asset)
        verify_manifest(members, manifest, version)
        verify_attestation(snapshot, version)
    if not os.path.isabs(prefix) or os.path.normpath(prefix) != prefix:
        refuse("installation prefix must be canonical and absolute")
    prefix = Path(prefix)
    releases = prefix / "releases"
    bin_dir = prefix / "bin"
    target = releases / version
    launcher = bin_dir / "omp-kit"
    for path in (prefix, releases, bin_dir, target):
        safe_directory(path)
    active = "../releases/" + version + "/bin/omp-kit"
    if launcher.is_symlink() and os.readlink(launcher) != active:
        prior = os.readlink(launcher)
        prior_version = prior[len("../releases/"):-len("/bin/omp-kit")]
        if (not prior.startswith("../releases/") or not prior.endswith("/bin/omp-kit")
                or not valid_version(prior_version)):
            refuse("unrecognized stable launcher symlink")
    elif launcher.exists() and not launcher.is_symlink():
        refuse("stable launcher already exists as a non-symlink")
    existing = target.exists()
    if existing:
        observed = list(target.rglob("*"))
        if any(path.is_symlink() for path in observed):
            refuse("existing version contains symlinks")
        actual = {str(path.relative_to(target)) for path in observed if path.is_file()}
        if actual != set(entry["path"] for entry in manifest["files"]) | {"release-manifest.json"}:
            refuse("existing version directory has unexpected files")
        for name, (kind, data) in members.items():
            if kind == "file" and (not (target / name).is_file() or sha((target / name).read_bytes()) != sha(data)):
                refuse("existing version differs from verified archive")
    if dry_run:
        print("verified dry-run: version=" + version + " platform=" + platform + " prefix=" + str(prefix))
        return
    ancestor = prefix
    while not ancestor.exists():
        ancestor = ancestor.parent
    if shutil.disk_usage(ancestor).free < sum(len(data) for kind, data in members.values() if kind == "file") + 20 * 1024 * 1024:
        refuse("insufficient free space for staged release")
    prefix.mkdir(mode=0o700, parents=True, exist_ok=True)
    safe_directory(prefix)
    for path in (releases, bin_dir):
        path.mkdir(mode=0o700, exist_ok=True)
        safe_directory(path)
    if not existing:
        staging = _extract_members(members, releases)
        try:
            with tempfile.TemporaryDirectory(prefix="omp-kit-probe-") as work:
                private = Path(work)
                env = {"PATH": os.defpath, "HOME": work, "TMPDIR": work,
                       "TMP": work, "TEMP": work}
                for key, directory in (("XDG_CONFIG_HOME", "config"), ("XDG_CACHE_HOME", "cache"),
                                       ("XDG_STATE_HOME", "state"), ("XDG_DATA_HOME", "data")):
                    location = private / directory
                    location.mkdir(mode=0o700)
                    env[key] = str(location)
                info = subprocess.run([str(staging / "bin/omp-kit"), "--info", "--json"],
                                      cwd=work, env=env, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, timeout=30, check=True)
            observed = parse_json(info.stdout)["data"]
            if observed["version"] != version or observed["release"]["source_tag"] != "v" + version:
                refuse("staged binary identity mismatch")
            if observed["platform"] != {"os": asset["os"], "arch": asset["arch"]}:
                refuse("staged binary platform mismatch")
            os.rename(staging, target)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    if not launcher.is_symlink() or os.readlink(launcher) != active:
        candidate = bin_dir / (".omp-kit-next-" + str(os.getpid()))
        os.symlink(active, candidate)
        try:
            os.replace(candidate, launcher)
        finally:
            if candidate.is_symlink():
                candidate.unlink()
    print("installed: version=" + version + " launcher=" + str(launcher))


if __name__ == "__main__":
    try:
        mode, index, version, platform, *rest = sys.argv[1:]
        if mode == "inspect" and not rest:
            print(index_asset(index, version, platform)["filename"])
        elif mode == "bundle" and not rest:
            download_attestation(index)
        elif mode == "attestation" and not rest:
            verify_attestation(index, version)
        elif mode == "install" and len(rest) == 3:
            install(index, version, platform, rest[0], rest[1], rest[2] == "1")
        else:
            refuse("invalid installer arguments")
    except (ValueError, OSError, KeyError, TypeError, IndexError, subprocess.SubprocessError) as exc:
        print("installer: refused: " + str(exc), file=sys.stderr)
        sys.exit(2)

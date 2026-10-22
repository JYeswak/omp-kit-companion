#!/bin/sh
# check-commit-imports.sh — FLY2-3 dangling-import gate (ompkit-uzgf).
# Usage: check-commit-imports.sh --repo DIR --base SHA --tip SHA
# Reviewed installed-layout data is optional; absent data keeps the strict gate.
# Validate before installation with --validate-template-import-map FILE --sha256 HEX.
# Every non-merge commit in base..tip must import only files present in its
# own tree. Reads git objects only; the working tree is never touched.
# Refuses (exit 4) naming the first offending sha and path.
# A trusted host Node + TypeScript compiler parses complete TS/TSX source blobs.
# Parser admission, syntax, decoding and budget failures are refusals, never skips.
set -u

REPO=""
BASE=""
TIP=""
VALIDATE=0
MAP_FILE=""
REVIEW_SHA=""
PARSER_INFO=0
RANGE_INPUT=0
SHA_INPUT=0
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) REPO=${2:-}; shift 2 ;;
		--base) RANGE_INPUT=1; BASE=${2:-}; shift 2 ;;
		--tip) RANGE_INPUT=1; TIP=${2:-}; shift 2 ;;
		--parser-info) PARSER_INFO=1; shift ;;
		--validate-template-import-map|--sha256)
			if [ $# -lt 2 ]; then
				printf 'check-commit-imports: invalid template import map\n' >&2
				exit 4
			fi
			if [ "$1" = --sha256 ]; then SHA_INPUT=1; REVIEW_SHA=$2; else VALIDATE=1; MAP_FILE=$2; fi
			shift 2 ;;
		--) shift; break ;;
		*) printf 'check-commit-imports: unknown argument %s\n' "$1" >&2; exit 2 ;;
	esac
done
# Resolve only the operator's host compiler, never a target package or config.
# Source bytes are git blobs; createSourceFile parses but never executes them.
native_imports() {
	node_bin=$(command -v node 2>/dev/null) || node_bin=""
	tsc_bin=$(command -v tsc 2>/dev/null) || tsc_bin=""
	if [ -z "$node_bin" ] || [ -z "$tsc_bin" ]; then
		printf 'check-commit-imports: PARSER_UNAVAILABLE (host node and tsc required)\n' >&2
		return 4
	fi
	NODE_OPTIONS='' NODE_PATH='' "$node_bin" --input-type=commonjs - "$tsc_bin" "$@" <<'JS'
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { TextDecoder } = require("node:util");
const [tscExecutable, mode, repo, sha, file] = process.argv.slice(2);
const SOURCE_BYTES = 4 * 1024 * 1024;
const OUTPUT_BYTES = 1024 * 1024;
const NODE_LIMIT = 250000;
const DEPTH_LIMIT = 4096;
const SPECIFIER_LIMIT = 4096;

function refuse(reason) {
    const error = new Error(reason);
    error.reason = reason;
    throw error;
}

function inside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
        !relative.startsWith(".." + path.sep));
}

function compiler() {
    let root, executable, modulePath, ts, fingerprint;
    try {
        root = fs.realpathSync(repo || process.cwd());
        executable = fs.realpathSync(tscExecutable);
        modulePath = fs.realpathSync(path.join(path.dirname(executable), "../lib/typescript.js"));
        if (inside(root, executable) || inside(root, modulePath) ||
            inside(root, fs.realpathSync(process.execPath))) {
            refuse("PARSER_INSIDE_TARGET");
        }
        if (!fs.statSync(modulePath).isFile()) refuse("PARSER_UNAVAILABLE");
        fingerprint = crypto.createHash("sha256").update(fs.readFileSync(modulePath)).digest("hex");
        ts = require(modulePath);
    } catch (error) {
        if (error && error.reason) throw error;
        refuse("PARSER_UNAVAILABLE");
    }
    const api = ["createSourceFile", "forEachChild", "isImportDeclaration", "isExportDeclaration",
        "isImportEqualsDeclaration", "isExternalModuleReference", "isCallExpression",
        "isImportTypeNode", "isLiteralTypeNode", "isStringLiteral", "isNoSubstitutionTemplateLiteral"];
    if (typeof ts.version !== "string" || !api.every(name => typeof ts[name] === "function") ||
        !ts.ScriptKind || !ts.ScriptTarget || !ts.SyntaxKind || !ts.NodeFlags ||
        typeof ts.ScriptKind.TSX !== "number" || typeof ts.ScriptKind.TS !== "number" ||
        typeof ts.ScriptTarget.Latest !== "number" || typeof ts.SyntaxKind.ImportKeyword !== "number" ||
        typeof ts.SyntaxKind.EndOfFileToken !== "number") {
        refuse("PARSER_UNAVAILABLE");
    }
    return { ts, info: { parser: "typescript", version: ts.version,
        module_path: modulePath, module_sha256: fingerprint } };
}

function git(...args) {
    try {
        return execFileSync("git", ["-C", repo, ...args],
            { maxBuffer: SOURCE_BYTES + 1, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
        refuse("SOURCE_UNAVAILABLE");
    }
}

function imports(ts) {
    const object = sha + ":" + file;
    const sizeText = git("cat-file", "-s", object).toString("ascii").trim();
    if (!/^[0-9]+$/.test(sizeText)) refuse("SOURCE_UNAVAILABLE");
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > SOURCE_BYTES) refuse("PARSER_SOURCE_BUDGET");
    const bytes = git("cat-file", "blob", object);
    if (bytes.length !== size || bytes.length > SOURCE_BYTES) refuse("SOURCE_UNAVAILABLE");
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        refuse("SOURCE_INVALID_UTF8");
    }
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
    if (!Array.isArray(source.parseDiagnostics)) refuse("PARSER_INCOMPLETE");
    if (source.parseDiagnostics.length) refuse("PARSER_SYNTAX_ERROR");
    if (source.end !== text.length || !source.endOfFileToken ||
        source.endOfFileToken.kind !== ts.SyntaxKind.EndOfFileToken ||
        source.endOfFileToken.end !== text.length) refuse("PARSER_INCOMPLETE");

    const specs = new Set();
    let outputBytes = 0;
    function add(literal) {
        if (!literal || !(ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))) return;
        const spec = literal.text;
        if (!(spec.startsWith("./") || spec.startsWith("../"))) return;
        // The shell transport is one decoded specifier per line, never lossy.
        if (/[\x00-\x1f\x7f]/.test(spec) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(spec)) {
            refuse("PARSER_SPECIFIER_UNSUPPORTED");
        }
        const length = Buffer.byteLength(spec, "utf8");
        if (length > SPECIFIER_LIMIT) refuse("PARSER_OUTPUT_BUDGET");
        if (!specs.has(spec)) {
            specs.add(spec);
            outputBytes += length + 1;
            if (specs.size > SPECIFIER_LIMIT || outputBytes > OUTPUT_BYTES) refuse("PARSER_OUTPUT_BUDGET");
        }
    }
    // Bounds here limit admitted traversal/output, not native parser peak RSS.
    const stack = [[source, 0]];
    let nodes = 0;
    while (stack.length) {
        const [node, depth] = stack.pop();
        if (++nodes > NODE_LIMIT || stack.length > NODE_LIMIT || depth > DEPTH_LIMIT) {
            refuse("PARSER_NODE_BUDGET");
        }
        if (node.pos < 0 || node.end < node.pos || node.end > text.length ||
            (node.flags & (ts.NodeFlags.ThisNodeHasError || 0))) refuse("PARSER_INCOMPLETE");
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            add(node.moduleSpecifier);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            add(node.moduleReference.expression);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            add(node.arguments[0]);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
            add(node.argument.literal);
        }
        // A block callback is required: returning push() stops forEachChild early.
        ts.forEachChild(node, child => { stack.push([child, depth + 1]); });
    }
    return [...specs].sort().map(spec => spec + "\n").join("");
}

try {
    const { ts, info } = compiler();
    process.stdout.write(mode === "info" ? JSON.stringify(info) + "\n" : imports(ts));
} catch (error) {
    process.stderr.write("check-commit-imports: " + ((error && error.reason) || "PARSER_FAILED") + "\n");
    process.exitCode = 4;
}
JS
}

if [ "$PARSER_INFO" = 1 ]; then
	if [ "$VALIDATE" = 1 ] || [ "$RANGE_INPUT" = 1 ] || [ "$SHA_INPUT" = 1 ]; then
		printf 'check-commit-imports: --parser-info cannot mix modes\n' >&2
		exit 2
	fi
	native_imports info "$REPO" "" ""
	exit $?
fi

# One strict-data implementation serves standalone validation and the fallback.
# It never executes project code. Declarations/maps are bounded to 1 MiB each.
template_import_map() {
	if ! command -v python3 >/dev/null 2>&1; then
		printf 'check-commit-imports: TEMPLATE_MAP_INTERPRETER_UNAVAILABLE\n' >&2
		return 4
	fi
	python3 - "$@" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import stat
import subprocess
import sys

LIMIT = 1024 * 1024


def reject_constant(value: str) -> object:
    raise ValueError("non-JSON constant")


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def parse_json(raw: bytes) -> object:
    if len(raw) > LIMIT:
        raise ValueError("oversized JSON")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                      parse_constant=reject_constant)


def read_file(path: str, limit: int = LIMIT) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError("not a regular file")
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("oversized file")
    return raw


def relative_path(value: object, *, root: bool = False, parent: bool = False) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("invalid relative path")
    value.encode("utf-8")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("control character in path")
    if value.startswith("/") or posixpath.normpath(value) != value:
        raise ValueError("noncanonical path")
    if value == "." and not root:
        raise ValueError("not a file path")
    if not parent and (value == ".." or value.startswith("../")):
        raise ValueError("path escapes repository")
    return value


def joined_path(root: str, path: str) -> str:
    return relative_path(posixpath.normpath(posixpath.join(root, path)))


def digest(value: object) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-fA-F]{64}", value) is None:
        raise ValueError("invalid digest")
    return value.lower()


def declaration(path: str, expected: str) -> list[dict[str, str]]:
    raw = read_file(path)
    if hashlib.sha256(raw).hexdigest() != digest(expected):
        raise ValueError("declaration digest mismatch")
    data = parse_json(raw)
    if not isinstance(data, dict) or set(data) != {"schema_version", "projections"}:
        raise ValueError("invalid declaration fields")
    if type(data["schema_version"]) is not int or data["schema_version"] != 1:
        raise ValueError("unsupported schema")
    projections = data["projections"]
    if not isinstance(projections, list) or not 1 <= len(projections) <= 256:
        raise ValueError("invalid projections")
    result: list[dict[str, str]] = []
    for item in projections:
        if not isinstance(item, dict) or set(item) != {
                "map_path", "map_sha256", "source_root", "install_root"}:
            raise ValueError("invalid projection fields")
        result.append({
            "map_path": relative_path(item["map_path"]),
            "map_sha256": digest(item["map_sha256"]),
            "source_root": relative_path(item["source_root"], root=True),
            "install_root": relative_path(item["install_root"], root=True),
        })
    return result


def git(repo: str, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", repo, *args], stderr=subprocess.DEVNULL)


def regular_blob(repo: str, sha: str, path: str) -> str | None:
    entries = git(repo, "ls-tree", "-z", sha, "--", path).split(b"\0")
    for entry in entries:
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        mode, kind, oid = metadata.split(b" ")
        if name == path.encode("utf-8") and mode in (b"100644", b"100755") and kind == b"blob":
            return oid.decode("ascii")
    return None


def candidates(target: str) -> list[str]:
    paths = [target, target + ".ts", target + ".tsx", target + ".mts", target + "/index.ts"]
    for extension, sources in ((".js", (".ts", ".tsx", ".d.ts")),
                               (".jsx", (".tsx",)), (".mjs", (".mts", ".d.mts")),
                               (".cjs", (".cts", ".d.cts"))):
        if target.endswith(extension):
            paths.extend(target[:-len(extension)] + source for source in sources)
            break
    return paths


def resolves(projections: list[dict[str, str]], repo: str, sha: str,
             importer: str, spec: str) -> bool:
    importer = relative_path(importer)
    if regular_blob(repo, sha, importer) is None:
        return False
    installed: dict[str, set[str]] = {}
    aliases: set[str] = set()
    for projection in projections:
        oid = regular_blob(repo, sha, projection["map_path"])
        if oid is None:
            continue
        if int(git(repo, "cat-file", "-s", oid)) > LIMIT:
            continue
        raw = git(repo, "cat-file", "blob", oid)
        if hashlib.sha256(raw).hexdigest() != projection["map_sha256"]:
            continue
        mapping = parse_json(raw)
        if not isinstance(mapping, dict) or not 1 <= len(mapping) <= 10000:
            raise ValueError("invalid install map")
        # Validate every path, but generated/unrelated outputs need not exist.
        for destination, source in mapping.items():
            destination = joined_path(projection["install_root"], relative_path(destination))
            source = joined_path(projection["source_root"], relative_path(source, parent=True))
            installed.setdefault(destination, set()).add(source)
            if source == importer:
                aliases.add(destination)
    if not aliases:
        return False
    for alias in aliases:
        target = joined_path(posixpath.dirname(alias) or ".", spec)
        for path in candidates(target):
            sources = installed.get(path, set())
            if sources and all(regular_blob(repo, sha, source) is not None for source in sources):
                break
        else:
            return False
    return True


def main() -> int:
    mode = sys.argv[1]
    if mode == "validate":
        declaration(sys.argv[2], sys.argv[3])
        return 0
    policy, pin, repo, sha, importer, spec = sys.argv[2:]
    expected = read_file(pin, 65).decode("ascii")
    if expected.endswith("\n"):
        expected = expected[:-1]
    projections = declaration(policy, expected)
    if mode == "active":
        return 0
    return 0 if resolves(projections, repo, sha, importer, spec) else 4


try:
    sys.exit(main())
except (OSError, ValueError, UnicodeError, RecursionError, subprocess.CalledProcessError):
    sys.exit(4)
PY
}

if [ "$VALIDATE" = 1 ]; then
	if [ -n "$REPO$BASE$TIP" ] || ! template_import_map validate "$MAP_FILE" "$REVIEW_SHA"; then
		printf 'check-commit-imports: invalid template import map\n' >&2
		exit 4
	fi
	exit 0
fi
if [ -z "$REPO" ] || [ -z "$BASE" ] || [ -z "$TIP" ] || [ -n "$REVIEW_SHA" ]; then printf 'check-commit-imports: --repo DIR --base SHA --tip SHA required\n' >&2; exit 2; fi

MAP_ACTIVE=0
HOOKS=$(git -C "$REPO" rev-parse --git-path hooks 2>/dev/null) || HOOKS=""
case "$HOOKS" in
	/*|"") ;;
	*) HOOKS="$REPO/$HOOKS" ;;
esac
MAP_FILE="$HOOKS/hooks.d/pre-commit/template-import-map.json"
MAP_PIN="$HOOKS/hooks.d/pre-commit/template-import-map.sha256"
if [ -n "$HOOKS" ] && { [ -e "$MAP_FILE" ] || [ -L "$MAP_FILE" ] || [ -e "$MAP_PIN" ] || [ -L "$MAP_PIN" ]; }; then
	if ! template_import_map active "$MAP_FILE" "$MAP_PIN" "$REPO" "$TIP" "" ""; then
		printf '%s invalid template import map %s (digest %s)\n' "$TIP" "$MAP_FILE" "$MAP_PIN" >&2
		exit 4
	fi
	MAP_ACTIVE=1
fi

# Resolve a ./x or ../x spec against the importing file's directory.
resolve_spec() {
	dir=$1
	spec=$2
	case "$spec" in
		./*) printf '%s' "$dir/${spec#./}" ;;
		../*)
			d=$dir
			s=$spec
			while :; do
				case "$s" in
					../*) s=${s#../} ;;
					*) break ;;
				esac
				case "$d" in
					"."|"") d="" ;;
					*/*) d=${d%/*} ;;
					*) d="" ;;
				esac
			done
			if [ -z "$d" ]; then printf '%s' "$s"; else printf '%s' "$d/$s"; fi ;;
		*) return 1 ;;
	esac
}

# exists_at PATH: the commit being judged ($sha) carries PATH.
exists_at() { git -C "$REPO" cat-file -e "$sha:$1" 2>/dev/null; }

# Literal and NodeNext/Bundler source lookup, independent of installed layouts.
source_target_exists() {
	source_target=$1
	for candidate in "$source_target" "$source_target.ts" "$source_target.tsx" "$source_target.mts" "$source_target/index.ts"; do
		exists_at "$candidate" && return 0
	done
	# Emitted extensions resolve to the corresponding TypeScript source.
	case "$source_target" in
		*.js)
			stem=${source_target%.js}
			for candidate in "$stem.ts" "$stem.tsx" "$stem.d.ts"; do
				exists_at "$candidate" && return 0
			done ;;
		*.jsx) exists_at "${source_target%.jsx}.tsx" && return 0 ;;
		*.mjs)
			stem=${source_target%.mjs}
			for candidate in "$stem.mts" "$stem.d.mts"; do
				exists_at "$candidate" && return 0
			done ;;
		*.cjs)
			stem=${source_target%.cjs}
			for candidate in "$stem.cts" "$stem.d.cts"; do
				exists_at "$candidate" && return 0
			done ;;
	esac
	return 1
}

# All findings accumulate in $OUT (pipelines run in subshells, so no
# early return across a pipe); a non-empty file is the refusal.
check_commit() {
	sha=$1
	if ! files=$(git -C "$REPO" diff-tree --root --no-commit-id --name-only -r --diff-filter=AM "$sha" -- '*.ts' '*.tsx' '*.mts' '*.cts' 2>/dev/null); then
		printf '%s cannot enumerate TypeScript source paths\n' "$sha" >> "$OUT"
		return
	fi
	[ -z "$files" ] && return 0
	printf '%s\n' "$files" | while IFS= read -r file; do
		[ -n "$file" ] || continue
		dir=${file%/*}
		[ "$dir" = "$file" ] && dir="."
		if specs=$(native_imports extract "$REPO" "$sha" "$file" 2>&1); then
			:
		else
			printf '%s cannot analyze %s: %s\n' "$sha" "$file" "${specs:-check-commit-imports: PARSER_FAILED}" >> "$OUT"
			continue
		fi
		printf '%s\n' "$specs" | while IFS= read -r spec; do
			[ -n "$spec" ] || continue
			target=$(resolve_spec "$dir" "$spec") || continue
			if source_target_exists "$target"; then
				continue
			fi
			if [ "$MAP_ACTIVE" = 1 ] && template_import_map resolve "$MAP_FILE" "$MAP_PIN" "$REPO" "$sha" "$file" "$spec"; then
				continue
			fi
			printf '%s imports missing %s (from %s)\n' "$sha" "$spec" "$file" >> "$OUT"
		done
	done
}

# Installed as a pre-commit sibling: kitlib-tmp.sh sits beside this file there and in scripts/.
kitlib_here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
[ -f "$kitlib_here/kitlib-tmp.sh" ] || { printf 'check-commit-imports: kitlib-tmp.sh missing beside %s; rerun scripts/install-commit-msg-bead.sh\n' "$0" >&2; exit 2; }
# shellcheck source=scripts/kitlib-tmp.sh
. "$kitlib_here/kitlib-tmp.sh"
KITLIB_TMP_ROOT=${TMPDIR:-$REPO/var/agent-tmp} # tempsafe: picks the kitlib root only, kitlib_tmp below owns the dir
mkdir -p "$KITLIB_TMP_ROOT" || { printf 'check-commit-imports: cannot stage findings\n' >&2; exit 2; }
findings_dir='' # assigned by kitlib_tmp via eval
kitlib_tmp findings_dir check-commit-imports || { printf 'check-commit-imports: cannot stage findings\n' >&2; exit 2; }
OUT=$findings_dir/findings
: > "$OUT"
if ! commits=$(git -C "$REPO" rev-list --no-merges "$BASE..$TIP" 2>/dev/null); then
	printf '%s cannot enumerate import-check range %s..%s\n' "$TIP" "$BASE" "$TIP" >&2
	exit 4
fi
for sha in $commits; do
	check_commit "$sha"
done
if [ -s "$OUT" ]; then
	head -5 "$OUT" >&2
	kitlib_tmp_cleanup "$findings_dir"
	exit 4
fi
kitlib_tmp_cleanup "$findings_dir"
exit 0

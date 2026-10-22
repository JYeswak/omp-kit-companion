#!/bin/sh
# check-staged-imports.test.sh — SHIFTLEFT1 pre-commit import gate contract
# (ompkit-1wgy). The member is installed by the installer into fixture repos
# and judged through real `git commit` runs: a staged file importing a path
# that is neither staged nor committed is refused; the `--only` temporary
# index is judged, not the full index.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

INSTALLER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/install-commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
if ! printenv TMPDIR >/dev/null; then KITLIB_TMP_ROOT=$REPO_TMP; fi
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP staged-imports-test || exit 1

pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && printf '%s' "$4" | grep -q -- "$5"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s out<<<%s>>>\n' "$3" "$1" "$2" "$4"; fi
}

new_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"* "$dir/.git/hooks/pre-commit"
	git -C "$dir" commit -q --allow-empty --message "[test] root"
	out=$(sh "$INSTALLER" "$dir" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
	[ -x "$dir/.git/hooks/hooks.d/pre-commit/45-omp-kit-staged-imports" ] || { printf 'FAIL install %s: member absent\n' "$1" >&2; exit 1; }
	printf '%s' "$dir"
}

commit() {
	repo=$1
	shift
	(CDPATH='' cd -- "$repo" && git commit -q "$@" 2>&1)
}

# 1. a.ts imports ./b.ts, b.ts untracked: refused, naming the import
R=$(new_repo untracked)
printf 'import { b } from "./b.ts";\nconsole.log(b);\n' > "$R/a.ts"
printf 'export const b = 1;\n' > "$R/b.ts"
git -C "$R" add a.ts
out=$(commit "$R" -m "[test] a without b")
check "$?" "1" "untracked-refused" "$out" "imports missing ./b.ts (from a.ts)"
check "$(git -C "$R" rev-list --count HEAD)" "1" "untracked-head-unmoved" "$out" "staged-imports: REFUSED"

# 2. both staged: passes
git -C "$R" add b.ts
out=$(commit "$R" -m "[test] a with b")
check "$?" "0" "both-staged-pass" "x" "x"

# 3. --only a.ts with b.ts committed earlier: passes
R=$(new_repo only-committed)
printf 'export const b = 1;\n' > "$R/b.ts"
git -C "$R" add b.ts
commit "$R" -m "[test] b first" > /dev/null
printf 'import { b } from "./b.ts";\nconsole.log(b);\n' > "$R/a.ts"
git -C "$R" add a.ts
out=$(commit "$R" --only a.ts -m "[test] a only")
check "$?" "0" "only-committed-pass" "x" "x"

# 4. --only a.ts while b.ts is staged in the full index but only in the
#    worktree for the commit: the --only temporary index lacks b.ts, refused
R=$(new_repo only-worktree)
printf 'import { b } from "./b.ts";\nconsole.log(b);\n' > "$R/a.ts"
printf 'export const b = 1;\n' > "$R/b.ts"
git -C "$R" add a.ts b.ts
out=$(commit "$R" --only a.ts -m "[test] a only, b left behind")
check "$?" "1" "only-worktree-refused" "$out" "imports missing ./b.ts (from a.ts)"

# 5. ../ imports resolve against the importing file's directory
R=$(new_repo parent)
mkdir -p "$R/src/lib" "$R/src/app"
printf 'export const u = 1;\n' > "$R/src/lib/util.ts"
printf 'import { u } from "../lib/util.ts";\nconsole.log(u);\n' > "$R/src/app/main.ts"
git -C "$R" add src
out=$(commit "$R" -m "[test] parent import" -m "[no-changelog] fixture")
check "$?" "0" "parent-valid-pass" "x" "x"
printf 'import { n } from "../lib/nope.ts";\nconsole.log(n);\n' > "$R/src/app/other.ts"
git -C "$R" add src/app/other.ts
out=$(commit "$R" -m "[test] parent import missing" -m "[no-changelog] fixture")
check "$?" "1" "parent-missing-refused" "$out" "imports missing ../lib/nope.ts (from src/app/other.ts)"

# 6. NodeNext emitted extensions resolve to their TypeScript sources
#    (./b.js -> b.ts, ./m.mjs -> m.mts, ./v.jsx -> v.tsx); a .js spec with
#    no source behind it is still refused.
R=$(new_repo nodenext)
printf 'export const b = 1;\n' > "$R/b.ts"
printf 'export const m = 1;\n' > "$R/m.mts"
printf 'export const v = 1;\n' > "$R/v.tsx"
printf 'import { b } from "./b.js";\nimport { m } from "./m.mjs";\nimport { v } from "./v.jsx";\nconsole.log(b, m, v);\n' > "$R/a.ts"
git -C "$R" add a.ts b.ts m.mts v.tsx
out=$(commit "$R" -m "[test] nodenext imports" -m "[no-changelog] fixture")
check "$?" "0" "nodenext-source-pass" "x" "x"
printf 'import { c } from "./c.js";\nconsole.log(c);\n' > "$R/d.ts"
git -C "$R" add d.ts
out=$(commit "$R" -m "[test] nodenext missing" -m "[no-changelog] fixture")
check "$?" "1" "nodenext-missing-refused" "$out" "imports missing ./c.js (from d.ts)"

# 7. Reviewed projection data is installed outside the candidate tree. The
# importer is an explicit map source; its installed ../logical import maps back
# to a regular committed source (including NodeNext .js -> .ts spelling).
R=$(new_repo reviewed-projection)
mkdir -p "$R/kit/templates" "$R/kit/src"
printf 'export const y = 1;\n' > "$R/kit/src/y.ts"
printf '{"hooks/x.ts":"templates/x.ts","logical/y.ts":"src/y.ts"}\n' > "$R/kit/install-files.json"
git -C "$R" add kit
commit "$R" -m "[test] projection sources" -m "[no-changelog] fixture" >/dev/null
MAP="$TMP/reviewed-map.json"
python3 - "$R" "$MAP" <<'PY'
import hashlib, json, pathlib, sys
repo, output = map(pathlib.Path, sys.argv[1:])
digest = hashlib.sha256((repo / "kit/install-files.json").read_bytes()).hexdigest()
output.write_text(json.dumps({"schema_version": 1, "projections": [{
    "map_path": "kit/install-files.json", "map_sha256": digest,
    "source_root": "kit", "install_root": ".omp"}]}) + "\n")
PY
SHA=$(shasum -a 256 "$MAP")
SHA=${SHA%% *}
# A linked pin must be refused before changing hooks or outside bytes.
PIN="$R/.git/hooks/hooks.d/pre-commit/template-import-map.sha256"
printf 'owned outside sentinel\n' > "$TMP/outside-pin"
cp "$TMP/outside-pin" "$TMP/outside-pin.before"
cp "$R/.git/hooks/pre-commit" "$TMP/link-hook.before"
ln -s "$TMP/outside-pin" "$PIN"
out=$(sh "$INSTALLER" --template-import-map "$MAP" --template-import-map-sha256 "$SHA" "$R" 2>&1)
check "$?" "2" "symlink-pin-refused" "$out" "unsafe template-import-map destination"
cmp "$TMP/outside-pin" "$TMP/outside-pin.before" >/dev/null
check "$?" "0" "symlink-outside-unchanged" "x" "x"
cmp "$R/.git/hooks/pre-commit" "$TMP/link-hook.before" >/dev/null
check "$?" "0" "symlink-hook-unchanged" "x" "x"
mv "$PIN" "$TMP/refused-pin-link"
out=$(sh "$INSTALLER" --template-import-map "$MAP" --template-import-map-sha256 "$SHA" "$R" 2>&1)
check "$?" "0" "reviewed-map-installed" "x" "x"
printf 'import { y } from "../logical/y.js";\nconsole.log(y);\n' > "$R/kit/templates/x.ts"
git -C "$R" add kit/templates/x.ts
out=$(commit "$R" -m "[test] projected importer" -m "[no-changelog] fixture")
check "$?" "0" "reviewed-projection-commit" "$out x" "x"

# No-option reinstall retains the exact approval and check recognizes it.
out=$(sh "$INSTALLER" "$R" 2>&1)
check "$?" "0" "reviewed-reinstall" "x" "x"
out=$(sh "$INSTALLER" --check --template-import-map "$MAP" --template-import-map-sha256 "$SHA" "$R" 2>&1)
check "$?" "0" "reviewed-reinstall-check" "$out" "hooks fresh"
out=$(cmp "$MAP" "$R/.git/hooks/hooks.d/pre-commit/template-import-map.json" 2>&1)
check "$?" "0" "reviewed-bytes-retained" "x" "x"
out=$(sh "$INSTALLER" --check "$R" 2>&1)
check "$?" "0" "reviewed-no-options-check" "$out" "hooks fresh"

# Reusing the already-installed reviewed declaration is idempotent, not a
# same-file cp failure after earlier members have been replaced.
LIVE_MAP="$R/.git/hooks/hooks.d/pre-commit/template-import-map.json"
out=$(sh "$INSTALLER" --template-import-map "$LIVE_MAP" --template-import-map-sha256 "$SHA" "$R" 2>&1)
check "$?" "0" "installed-declaration-reused" "$out" "installed staged-imports member"
out=$(sh "$INSTALLER" --check --template-import-map "$LIVE_MAP" --template-import-map-sha256 "$SHA" "$R" 2>&1)
check "$?" "0" "installed-declaration-recheck" "$out" "hooks fresh"

# Refusal must precede changes even when a complete install already exists.
cp "$R/.git/hooks/pre-commit" "$TMP/pre-commit.before"
cp "$R/.git/hooks/hooks.d/pre-commit/template-import-map.json" "$TMP/map.before"
out=$(sh "$INSTALLER" --template-import-map "$MAP" --template-import-map-sha256 "$(printf '%064d' 0)" "$R" 2>&1)
rc=$?
if [ "$rc" != 0 ]; then rc=1; fi
check "$rc" "1" "bad-reviewed-hash-refused" "$out" "invalid template import map"
cmp "$TMP/pre-commit.before" "$R/.git/hooks/pre-commit" >/dev/null
check "$?" "0" "bad-hash-hook-unchanged" "x" "x"
cmp "$TMP/map.before" "$R/.git/hooks/hooks.d/pre-commit/template-import-map.json" >/dev/null
check "$?" "0" "bad-hash-data-unchanged" "x" "x"

# Draft changes cannot activate an unreviewed mapping.
printf '{"hooks/x.ts":"templates/x.ts","logical/z.ts":"src/z.ts"}\n' > "$R/kit/install-files.json"
printf 'export const z = 1;\n' > "$R/kit/src/z.ts"
printf 'import { z } from "../logical/z.js";\nconsole.log(z);\n' > "$R/kit/templates/x.ts"
git -C "$R" add kit
out=$(commit "$R" -m "[test] draft map" -m "[no-changelog] fixture")
check "$?" "1" "draft-cannot-activate" "$out" "staged-imports: REFUSED"
git -C "$R" reset -q HEAD -- kit
git -C "$R" show HEAD:kit/install-files.json > "$R/kit/install-files.json"

# Declared target absent from the map, missing mapped source, and ordinary
# dangling imports all remain real commit refusals.
printf 'import { z } from "../logical/z.js";\nconsole.log(z);\n' > "$R/kit/templates/x.ts"
git -C "$R" add kit/templates/x.ts
out=$(commit "$R" -m "[test] undeclared target" -m "[no-changelog] fixture")
check "$?" "1" "undeclared-target-refused" "$out" "staged-imports: REFUSED"
printf 'import { y } from "../logical/y.js";\nconsole.log(y); // mapped source removed\n' > "$R/kit/templates/x.ts"
git -C "$R" rm -q kit/src/y.ts
git -C "$R" add kit/templates/x.ts
out=$(commit "$R" -m "[test] missing mapped source" -m "[no-changelog] fixture")
check "$?" "1" "mapped-source-missing-refused" "$out" "staged-imports: REFUSED"
git -C "$R" reset -q HEAD -- kit
printf 'import "./absent.ts";\n' > "$R/ordinary.ts"
git -C "$R" add ordinary.ts
out=$(commit "$R" -m "[test] ordinary dangling" -m "[no-changelog] fixture")
check "$?" "1" "ordinary-dangling-refused" "$out" "imports missing ./absent.ts"

# --check is read-only and names missing/tampered requested configuration.
PIN="$R/.git/hooks/hooks.d/pre-commit/template-import-map.sha256"
printf '%064d\n' 0 > "$PIN"
cp "$PIN" "$TMP/pin.tampered"
out=$(sh "$INSTALLER" --check --template-import-map "$MAP" --template-import-map-sha256 "$SHA" "$R" 2>&1)
check "$?" "3" "tampered-map-check" "$out" "MISSING or STALE reviewed template-import-map"
cmp "$PIN" "$TMP/pin.tampered" >/dev/null
check "$?" "0" "check-preserves-tampering" "x" "x"
mv "$R/.git/hooks/hooks.d/pre-commit/template-import-map.json" "$TMP/map.removed"
out=$(sh "$INSTALLER" --check --template-import-map "$MAP" --template-import-map-sha256 "$SHA" "$R" 2>&1)
check "$?" "3" "missing-map-check" "$out" "MISSING or STALE reviewed template-import-map"
if [ ! -e "$R/.git/hooks/hooks.d/pre-commit/template-import-map.json" ]; then
	map_absence_rc=0
else
	map_absence_rc=1
fi
check "$map_absence_rc" "0" "check-does-not-create-map" "x" "x"

# 8. The installed ordinary-source parser must not interpret quoted examples,
# comments, template text or regexp contents as actual import declarations.
R=$(new_repo ordinary-quoted-examples)
cat > "$R/examples.ts" <<'TS'
export const examples = [
  'import { absent } from "./quoted.ts";',
  "export { absent } from './quoted-export.ts';",
  'import("./quoted-dynamic.ts")',
  `import { absent } from "./template-text.ts";`,
];
export const importPattern = /import \{ absent \} from "\.\/regexp-text.ts"/;
// import { absent } from "./comment.ts";
/*
import { absent } from "./block-comment.ts";
*/
TS
git -C "$R" add examples.ts
out=$(commit "$R" -m "[test] quoted import examples")
check "$?" "0" "ordinary-quoted-examples-pass" "$out x" "x"

# Actual static, type-only, and literal dynamic imports remain obligations.
for kind in static type dynamic; do
	R=$(new_repo "ordinary-real-$kind")
	case "$kind" in
		static) printf 'import { absent } from "./real-static.ts";\nconsole.log(absent);\n' > "$R/actual.ts" ;;
		type) printf 'import type { Absent } from "./real-type.ts";\nexport type Used = Absent;\n' > "$R/actual.ts" ;;
		dynamic) printf 'export const pending = import("./real-dynamic.ts");\n' > "$R/actual.ts" ;;
	esac
	git -C "$R" add actual.ts
	out=$(commit "$R" -m "[test] real $kind dangling import")
	check "$?" "1" "ordinary-real-$kind-refused" "$out" "imports missing ./real-$kind.ts"
done

# Parser admission must precede changing an existing chain. A restricted
# executable set supplies Git/path setup but deliberately no Node or tsc.
R=$(new_repo parser-admission)
mkdir "$TMP/no-parser"
ln -s "$(command -v cmp)" "$TMP/no-parser/cmp"
ln -s "$(command -v git)" "$TMP/no-parser/git"
ln -s "$(command -v dirname)" "$TMP/no-parser/dirname"
ln -s /bin/sh "$TMP/no-parser/sh"
cp "$R/.git/hooks/pre-commit" "$TMP/parser-hook.before"
out=$(PATH="$TMP/no-parser" /bin/sh "$INSTALLER" "$R" 2>&1)
check "$?" "2" "missing-parser-install-refused" "$out" "REFUSED import parser unavailable"
cmp "$R/.git/hooks/pre-commit" "$TMP/parser-hook.before" >/dev/null
check "$?" "0" "missing-parser-hook-unchanged" "x" "x"
out=$(PATH="$TMP/no-parser" /bin/sh "$INSTALLER" --check "$R" 2>&1)
check "$?" "3" "missing-parser-check-stale" "$out" "MISSING or STALE installed import parser"
cmp "$R/.git/hooks/pre-commit" "$TMP/parser-hook.before" >/dev/null
check "$?" "0" "missing-parser-check-readonly" "x" "x"

printf 'check-staged-imports: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]

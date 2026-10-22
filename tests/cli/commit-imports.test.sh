#!/bin/sh
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# commit-imports.test.sh — FLY2-3 dangling-import gate contract
# (ompkit-uzgf). Fixture repos where HEAD imports a missing file must be
# refused naming sha+path; clean trees pass. Every verdict comes from the
# exit code plus the complete output.
set -u

CHECKER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/check-commit-imports.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
umask 077
if ! printenv TMPDIR >/dev/null; then KITLIB_TMP_ROOT=$REPO_TMP; fi
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP commit-imports-test || exit 1

pass=0
fail=0

mkrepo() {
	name=$1
	repo="$TMP/$name"
	mkdir -p "$repo"
	git -C "$repo" init -q
	git -C "$repo" config user.email "test@example.invalid"
	git -C "$repo" config user.name "worker-1"
	mkdir -p "$repo/src"
	printf 'export const ok = 1;\n' > "$repo/src/ok.ts"
	printf 'import { ok } from "./ok.ts";\nconsole.log(ok);\n' > "$repo/src/main.ts"
	git -C "$repo" add -A
	git -C "$repo" commit -qm "[test] base clean tree"
	printf '%s' "$repo"
}

# 1. planted: HEAD imports a file missing from its tree; refused naming sha+path
repo=$(mkrepo dangling)
printf 'import { gone } from "./missing.ts";\nconsole.log(gone);\n' > "$repo/src/main.ts"
git -C "$repo" add -A
git -C "$repo" commit -qm "[test] head with dangling import"
base=$(git -C "$repo" rev-parse HEAD~1)
head=$(git -C "$repo" rev-parse HEAD)
out=$(sh "$CHECKER" --repo "$repo" --base "$base" --tip "$head" 2>&1)
rc=$?
if [ "$rc" = "4" ] && printf '%s' "$out" | grep -q "$head" && printf '%s' "$out" | grep -q "./missing.ts"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL dangling-refused: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

repo2=$(mkrepo clean)
printf 'export const ok = 2;\n' > "$repo2/src/ok.ts"
git -C "$repo2" add -A
git -C "$repo2" commit -qm "[test] clean second commit"
base2=$(git -C "$repo2" rev-parse HEAD~1)
head2=$(git -C "$repo2" rev-parse HEAD)
out=$(sh "$CHECKER" --repo "$repo2" --base "$base2" --tip "$head2" 2>&1)
rc=$?
if [ "$rc" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL clean-passes: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi
# 3. a valid 60KB single-line source is parsed completely without hanging.

repo3=$(mkrepo minified)
python3 -c "open('$repo3/src/big.ts','w').write('import { ok } from \"./ok.ts\"; // ' + 'x'*60000 + '\n')"
git -C "$repo3" add -A
git -C "$repo3" commit -qm "[test] minified line"
base3=$(git -C "$repo3" rev-parse HEAD~1)
head3=$(git -C "$repo3" rev-parse HEAD)
start=$(date +%s)
out=$(sh "$CHECKER" --repo "$repo3" --base "$base3" --tip "$head3" 2>&1)
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" = "0" ] && [ "$elapsed" -lt 30 ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL minified-fast: rc=%s elapsed=%s out<<<%s>>>\n' "$rc" "$elapsed" "$out"
fi

# 4. planted: valid ../../src import from tests/cli passes (multi-level ../)
repo4=$(mkrepo multilevel)
mkdir -p "$repo4/tests/cli"
printf 'export const deep = 1;\n' > "$repo4/src/deep.ts"
printf 'import { deep } from "../../src/deep.ts";\nconsole.log(deep);\n' > "$repo4/tests/cli/check.ts"
git -C "$repo4" add -A
git -C "$repo4" commit -qm "[test] valid multilevel relative import"
base4=$(git -C "$repo4" rev-parse HEAD~1)
head4=$(git -C "$repo4" rev-parse HEAD)
out=$(sh "$CHECKER" --repo "$repo4" --base "$base4" --tip "$head4" 2>&1)
rc=$?
if [ "$rc" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL multilevel-valid: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi
# 5. planted: missing ../../src/nope.ts from tests/cli is still refused
repo5=$(mkrepo multilevel-dangling)
mkdir -p "$repo5/tests/cli"
printf 'import { nope } from "../../src/nope.ts";\nconsole.log(nope);\n' > "$repo5/tests/cli/check.ts"
git -C "$repo5" add -A
git -C "$repo5" commit -qm "[test] dangling multilevel import"
base5=$(git -C "$repo5" rev-parse HEAD~1)
head5=$(git -C "$repo5" rev-parse HEAD)
out=$(sh "$CHECKER" --repo "$repo5" --base "$base5" --tip "$head5" 2>&1)
rc=$?
if [ "$rc" = "4" ] && printf '%s' "$out" | grep -q "$head5" && printf '%s' "$out" | grep -q "nope.ts"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL multilevel-dangling: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# Installed-layout imports are checked against reviewed, digest-bound project
# data, never an exemption for the template directory.
review_map() {
	python3 - "$1" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
mapping = root / "kit/install-files.json"
policy = {"schema_version": 1, "projections": [{"map_path": "kit/install-files.json",
          "map_sha256": hashlib.sha256(mapping.read_bytes()).hexdigest(),
          "source_root": "kit/templates", "install_root": ".omp"}]}
dest = root / ".git/hooks/hooks.d/pre-commit/template-import-map.json"
raw = (json.dumps(policy) + "\n").encode()
dest.write_bytes(raw)
dest.with_suffix(".sha256").write_text(hashlib.sha256(raw).hexdigest() + "\n")
PY
}

template_repo() {
	repo=$(mkrepo "$1")
	mkdir -p "$repo/kit/templates/omp/tools" "$repo/kit/src" "$repo/.git/hooks/hooks.d/pre-commit"
	printf 'export const y = 1;\n' > "$repo/kit/src/y.ts"
	printf 'import { y } from "../jev-kit/y.ts";\nconsole.log(y);\n' > "$repo/kit/templates/omp/tools/tool.ts"
	printf '{"tools/tool.ts":"omp/tools/tool.ts","jev-kit/y.ts":"../src/y.ts"}\n' > "$repo/kit/install-files.json"
	review_map "$repo"
	printf '%s' "$repo"
}

repo6=$(template_repo installed-template)
git -C "$repo6" add -A
git -C "$repo6" commit -qm "[test] declared installed-layout template"
base6=$(git -C "$repo6" rev-parse HEAD~1)
head6=$(git -C "$repo6" rev-parse HEAD)
out=$(sh "$CHECKER" --repo "$repo6" --base "$base6" --tip "$head6" 2>&1)
rc=$?
printf 'installed-template-positive: rc=%s out<<<%s>>>\n' "$rc" "$out"
if [ "$rc" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL installed-template-positive: rc=%s\n' "$rc"
fi

# New cases always retain the full output and exact return code.
commit_fixture() {
	git -C "$1" add -A
	git -C "$1" commit -qm "[test] $2"
}

expect_guard() {
	label=$1
	repo=$2
	expected=$3
	needle=$4
	base=$(git -C "$repo" rev-parse "${5:-HEAD~1}")
	head=$(git -C "$repo" rev-parse HEAD)
	out=$(sh "$CHECKER" --repo "$repo" --base "$base" --tip "$head" 2>&1)
	rc=$?
	printf '%s: rc=%s out<<<%s>>>\n' "$label" "$rc" "$out"
	if [ "$rc" = "$expected" ] && { [ "$expected" = 0 ] || {
		printf '%s' "$out" | grep -Fq "$head" &&
		printf '%s' "$out" | grep -Fq "$needle"
	}; }; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1)); printf 'FAIL %s\n' "$label"
	fi
}

# No destination is not permission to treat the whole template prefix as safe.
repo=$(template_repo no-installed-destination)
printf '{"tools/tool.ts":"omp/tools/tool.ts"}\n' > "$repo/kit/install-files.json"
review_map "$repo"
commit_fixture "$repo" "missing installed destination"
expect_guard no-installed-destination "$repo" 4 "kit/templates/omp/tools/tool.ts"

# A reviewed destination must point to a source blob in this commit, not HEAD
# or a convenient untracked/worktree file.
repo=$(template_repo mapped-source-missing)
printf '{"tools/tool.ts":"omp/tools/tool.ts","jev-kit/y.ts":"../src/missing.ts"}\n' > "$repo/kit/install-files.json"
review_map "$repo"
commit_fixture "$repo" "referenced mapped source absent"
printf 'export const y = 1;\n' > "$repo/kit/src/missing.ts"
expect_guard mapped-source-missing "$repo" 4 "kit/templates/omp/tools/tool.ts"

repo=$(template_repo ordinary-dangling)
printf 'import { gone } from "./gone.ts";\nconsole.log(gone);\n' > "$repo/src/main.ts"
commit_fixture "$repo" "ordinary dangling source beside reviewed templates"
expect_guard ordinary-dangling "$repo" 4 "./gone.ts"

repo=$(template_repo unmapped-importer)
printf 'import { y } from "../jev-kit/y.ts";\nconsole.log(y);\n' > "$repo/kit/templates/omp/tools/unmapped.ts"
commit_fixture "$repo" "unmapped template importer"
expect_guard unmapped-importer "$repo" 4 "kit/templates/omp/tools/unmapped.ts"

repo=$(template_repo unreviewed-candidate-map)
printf '{"tools/tool.ts":"omp/tools/tool.ts","jev-kit/y.ts":"../src/forged.ts"}\n' > "$repo/kit/install-files.json"
printf 'export const y = 2;\n' > "$repo/kit/src/forged.ts"
# A candidate's own updated declaration/digest is not operator activation.
python3 - "$repo" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
policy = json.loads((root / ".git/hooks/hooks.d/pre-commit/template-import-map.json").read_text())
policy["projections"][0]["map_sha256"] = hashlib.sha256((root / "kit/install-files.json").read_bytes()).hexdigest()
raw = (json.dumps(policy) + "\n").encode()
(root / "template-import-map.json").write_bytes(raw)
(root / "template-import-map.sha256").write_text(hashlib.sha256(raw).hexdigest() + "\n")
PY
commit_fixture "$repo" "candidate cannot self-review a map mutation"
expect_guard unreviewed-candidate-map "$repo" 4 "kit/templates/omp/tools/tool.ts"

repo=$(template_repo tampered-policy)
printf ' ' >> "$repo/.git/hooks/hooks.d/pre-commit/template-import-map.json"
commit_fixture "$repo" "tampered installed declaration"
expect_guard tampered-policy "$repo" 4 "template-import-map.json"

repo=$(template_repo tampered-digest)
printf '%064d\n' 0 > "$repo/.git/hooks/hooks.d/pre-commit/template-import-map.sha256"
commit_fixture "$repo" "tampered installed digest"
expect_guard tampered-digest "$repo" 4 "template-import-map.sha256"

repo=$(template_repo missing-digest)
rm -f "$repo/.git/hooks/hooks.d/pre-commit/template-import-map.sha256"
commit_fixture "$repo" "missing installed digest"
expect_guard missing-digest "$repo" 4 "template-import-map.sha256"

repo=$(template_repo missing-policy)
rm -f "$repo/.git/hooks/hooks.d/pre-commit/template-import-map.json"
commit_fixture "$repo" "missing installed declaration"
expect_guard missing-policy "$repo" 4 "template-import-map.json"

repo=$(template_repo no-activation)
rm -f "$repo/.git/hooks/hooks.d/pre-commit/template-import-map.json" "$repo/.git/hooks/hooks.d/pre-commit/template-import-map.sha256"
commit_fixture "$repo" "strict default without activation"
expect_guard no-activation "$repo" 4 "kit/templates/omp/tools/tool.ts"

# Resolving only the first alias would accept this broken second installation.
repo=$(template_repo multiple-aliases)
printf '{"tools/tool.ts":"omp/tools/tool.ts","other/deep/tool.ts":"omp/tools/tool.ts","jev-kit/y.ts":"../src/y.ts"}\n' > "$repo/kit/install-files.json"
review_map "$repo"
commit_fixture "$repo" "one of two installed importer aliases dangles"
expect_guard all-importer-aliases "$repo" 4 "kit/templates/omp/tools/tool.ts"

# NodeNext target spellings use exactly the ordinary candidate classes.
repo=$(template_repo nodenext-projection)
printf 'import { y } from "../jev-kit/y.js";\nconsole.log(y);\n' > "$repo/kit/templates/omp/tools/tool.ts"
commit_fixture "$repo" "installed NodeNext target resolves to mapped TypeScript source"
expect_guard nodenext-projection "$repo" 0 ""

# Unreferenced generated outputs do not have to be committed source blobs.
repo=$(template_repo unrelated-generated-output)
printf '{"tools/tool.ts":"omp/tools/tool.ts","jev-kit/y.ts":"../src/y.ts","bin/runner.js":"../dist/runner.js"}\n' > "$repo/kit/install-files.json"
review_map "$repo"
commit_fixture "$repo" "unrelated generated output is not an import obligation"
expect_guard unrelated-generated-output "$repo" 0 ""

# A regular-file requirement prevents a symlink's contents becoming evidence.
repo=$(template_repo symlink-target)
printf '{"tools/tool.ts":"omp/tools/tool.ts","jev-kit/y.ts":"../src/link.ts"}\n' > "$repo/kit/install-files.json"
ln -s y.ts "$repo/kit/src/link.ts"
review_map "$repo"
commit_fixture "$repo" "mapped target is a symlink rather than source blob"
expect_guard symlink-target "$repo" 4 "kit/templates/omp/tools/tool.ts"

# Different reviewed map versions may coexist in the activated declaration.
repo=$(template_repo reviewed-map-versions)
commit_fixture "$repo" "first reviewed map version"
python3 - "$repo" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
mapping = root / "kit/install-files.json"
mapping.write_text('{"tools/tool.ts":"omp/tools/tool.ts","jev-kit/y.ts":"../src/y.ts","bin/generated.js":"../dist/generated.js"}\n')
policy_path = root / ".git/hooks/hooks.d/pre-commit/template-import-map.json"
policy = json.loads(policy_path.read_text())
next_projection = dict(policy["projections"][0])
next_projection["map_sha256"] = hashlib.sha256(mapping.read_bytes()).hexdigest()
policy["projections"].append(next_projection)
raw = (json.dumps(policy) + "\n").encode()
policy_path.write_bytes(raw)
policy_path.with_suffix(".sha256").write_text(hashlib.sha256(raw).hexdigest() + "\n")
PY
printf '// changed in the second reviewed version\n' >> "$repo/kit/templates/omp/tools/tool.ts"
commit_fixture "$repo" "second reviewed map version"
expect_guard reviewed-map-versions "$repo" 0 "" HEAD~2

# Direct invocation and installed hooks locate the same core.hooksPath copy.
repo=$(template_repo configured-hooks-path)
mv "$repo/.git/hooks/hooks.d" "$repo/reviewed-hooks"
mkdir "$repo/operator-hooks"
mv "$repo/reviewed-hooks" "$repo/operator-hooks/hooks.d"
git -C "$repo" config core.hooksPath operator-hooks
commit_fixture "$repo" "configured Git hooks path"
expect_guard configured-hooks-path "$repo" 0 ""

repo=$(template_repo missing-python)
commit_fixture "$repo" "enabled policy requires Python"
mkdir "$repo/no-python"
ln -s "$(command -v git)" "$repo/no-python/git"
base=$(git -C "$repo" rev-parse HEAD~1)
head=$(git -C "$repo" rev-parse HEAD)
out=$(PATH="$repo/no-python" /bin/sh "$CHECKER" --repo "$repo" --base "$base" --tip "$head" 2>&1)
rc=$?
printf 'missing-python: rc=%s out<<<%s>>>\n' "$rc" "$out"
if [ "$rc" = 4 ] && printf '%s' "$out" | grep -Fq "$head" && printf '%s' "$out" | grep -Fq "template-import-map.json"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL missing-python\n'
fi

# The optional fallback must not change ordinary emitted-extension resolution.
repo=$(mkrepo ordinary-nodenext)
printf 'export const a = 1;\n' > "$repo/src/a.ts"
printf 'export const b = 1;\n' > "$repo/src/b.tsx"
printf 'export const c = 1;\n' > "$repo/src/c.mts"
printf 'export const d = 1;\n' > "$repo/src/d.cts"
printf 'import { a } from "./a.js";\nimport { b } from "./b.jsx";\nimport { c } from "./c.mjs";\nimport { d } from "./d.cjs";\n' > "$repo/src/main.ts"
commit_fixture "$repo" "ordinary NodeNext extension candidates"
expect_guard ordinary-nodenext "$repo" 0 ""

# Standalone validation needs neither repository nor commit arguments.
policy="$repo6/.git/hooks/hooks.d/pre-commit/template-import-map.json"
policy_sha=$(cat "$repo6/.git/hooks/hooks.d/pre-commit/template-import-map.sha256")
out=$(sh "$CHECKER" --validate-template-import-map "$policy" --sha256 "$policy_sha" 2>&1)
rc=$?
printf 'standalone-valid: rc=%s out<<<%s>>>\n' "$rc" "$out"
if [ "$rc" = 0 ] && [ -z "$out" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL standalone-valid\n'
fi

expect_invalid_policy() {
	label=$1
	policy=$2
	policy_sha=$3
	out=$(sh "$CHECKER" --validate-template-import-map "$policy" --sha256 "$policy_sha" 2>&1)
	rc=$?
	printf '%s: rc=%s out<<<%s>>>\n' "$label" "$rc" "$out"
	if [ "$rc" = 4 ] && [ "$out" = "check-commit-imports: invalid template import map" ]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1)); printf 'FAIL %s\n' "$label"
	fi
}

expect_invalid_policy standalone-wrong-digest "$policy" "$(printf '%064d' 0)"
expect_invalid_policy standalone-missing-file "$TMP/absent.json" "$policy_sha"
for malformed in duplicate unknown-field boolean-version escape absolute noncanonical invalid-json oversize; do
	policy="$TMP/invalid-$malformed.json"
	policy_sha=$(python3 - "$policy" "$malformed" <<'PY'
import hashlib, json, pathlib, sys
path, case = pathlib.Path(sys.argv[1]), sys.argv[2]
projection = {"map_path": "kit/install-files.json", "map_sha256": "a" * 64,
              "source_root": "kit/templates", "install_root": ".omp"}
data = {"schema_version": 1, "projections": [projection]}
if case == "unknown-field":
    projection["exempt"] = True
elif case == "boolean-version":
    data["schema_version"] = True
elif case == "escape":
    projection["source_root"] = "../outside"
elif case == "absolute":
    projection["install_root"] = "/outside"
elif case == "noncanonical":
    projection["map_path"] = "kit/../install-files.json"
raw = (json.dumps(data) + "\n").encode()
if case == "duplicate":
    raw = raw.replace(b'"schema_version": 1', b'"schema_version": 1, "schema_version": 1')
elif case == "invalid-json":
    raw = b'{"schema_version": NaN, "projections": []}\n'
elif case == "oversize":
    raw += b" " * (1024 * 1024)
path.write_bytes(raw)
print(hashlib.sha256(raw).hexdigest())
PY
)
	expect_invalid_policy "standalone-$malformed" "$policy" "$policy_sha"
done

# Candidate-map JSON is strict too, even if its exact bytes were declared.
for malformed in duplicate unsafe-source unsafe-destination nonstring; do
	repo=$(template_repo "invalid-map-$malformed")
	python3 - "$repo/kit/install-files.json" "$malformed" <<'PY'
import pathlib, sys
path, case = pathlib.Path(sys.argv[1]), sys.argv[2]
base = '{"tools/tool.ts":"omp/tools/tool.ts","jev-kit/y.ts":"../src/y.ts"'
extra = {"duplicate": ',"tools/tool.ts":"omp/tools/tool.ts"',
         "unsafe-source": ',"unrelated.ts":"../../../outside.ts"',
         "unsafe-destination": ',"../escape.ts":"../src/y.ts"',
         "nonstring": ',"unrelated.ts":true'}[case]
path.write_text(base + extra + "}\n")
PY
	review_map "$repo"
	commit_fixture "$repo" "invalid reviewed map data"
	expect_guard "invalid-map-$malformed" "$repo" 4 "kit/templates/omp/tools/tool.ts"
done

# Ordinary fixture strings/comments/regex/template text are not module imports.
repo=$(mkrepo lexical-inert)
cat > "$repo/src/ordinary.ts" <<'TS'
const typeFixture = "import type { Missing } from './missing-type';";
const sourceFixture = 'import { missing } from "./jev-only-relative-helper";';
const rawTemplate = `export type { Missing } from "./missing-type-too";`;
const pattern = /from ".\/regex-only"/;
/* import { missing } from "./block-comment-only"; */
// import { missing } from "./line-comment-only";
export const done = true;
TS
commit_fixture "$repo" "inert import fixtures are not dependencies"
expect_guard lexical-inert "$repo" 0 ""
repo=$(mkrepo lexical-jsx)
cat > "$repo/src/view.tsx" <<'TSX'
export const View = () => <div title={"from './jsx-attribute-only'"}>from "./jsx-text-only"</div>;
TSX
commit_fixture "$repo" "JSX text is not a module declaration"
expect_guard lexical-jsx "$repo" 0 ""

# Preserve real static/type/dynamic dependencies, including executable template
# expressions and decoded specifiers; an erased-type scanner is insufficient.
for kind in static type dynamic import-type template escaped backtick later; do
	repo=$(mkrepo "lexical-real-$kind")
	case "$kind" in
		static) code='import { Missing } from "./missing-static";'; needle=missing-static ;;
		type) code='import type { Missing } from "./missing-type-real";'; needle=missing-type-real ;;
		dynamic) code='void import("./missing-dynamic");'; needle=missing-dynamic ;;
		import-type) code='type Missing = import("./missing-type-expression").Missing;'; needle=missing-type-expression ;;
		template)
			code=$(cat <<'TS'
const value = `inert from "./template-raw-only" ${import("./missing-template-expression")}`;
TS
)
			needle=missing-template-expression ;;
		escaped) code='void import("\u002e/missing-escaped");'; needle=missing-escaped ;;
		backtick)
			code=$(cat <<'TS'
void import(`./missing-backtick`);
TS
)
			needle=missing-backtick ;;
		later) code='import { ok } from "./ok.ts"; type Missing = import("./missing-later").Missing;'; needle=missing-later ;;
	esac
	printf '%s\n' "$code" > "$repo/src/ordinary.ts"
	commit_fixture "$repo" "real $kind module dependency stays checked"
	expect_guard "lexical-real-$kind" "$repo" 4 "$needle"
done
repo=$(mkrepo lexical-valid)
printf '%s\n' 'import type { ok } from "./ok.ts"; void import("./ok.ts");' > "$repo/src/ordinary.ts"
commit_fixture "$repo" "valid real type and dynamic imports pass"
expect_guard lexical-valid "$repo" 0 ""

# Native parsing failure is not evidence that a source has no dependencies.
for kind in malformed incomplete utf8 source-budget node-budget output-budget; do
	repo=$(mkrepo "parser-refusal-$kind")
	python3 - "$repo/src/ordinary.ts" "$kind" <<'PY'
import pathlib, sys
path, kind = pathlib.Path(sys.argv[1]), sys.argv[2]
data = {
    "malformed": b'const broken = ;\nvoid import("./ok.ts");\n',
    "incomplete": b'export const prefix = 1;\n/* unterminated',
    "utf8": b'export const valid = 1;\n// invalid UTF-8: \xff\n',
    "source-budget": b"//" + b"x" * (4 * 1024 * 1024) + b"\n",
    "node-budget": b"0;\n" * 130000,
    "output-budget": b'void import("./' + b"x" * 4096 + b'");\n',
}[kind]
path.write_bytes(data)
PY
	commit_fixture "$repo" "native parser $kind must refuse"
	case "$kind" in
		malformed|incomplete) reason=PARSER_SYNTAX_ERROR ;;
		utf8) reason=SOURCE_INVALID_UTF8 ;;
		source-budget) reason=PARSER_SOURCE_BUDGET ;;
		node-budget) reason=PARSER_NODE_BUDGET ;;
		output-budget) reason=PARSER_OUTPUT_BUDGET ;;
	esac
	expect_guard "parser-refusal-$kind" "$repo" 4 "$reason"
	if printf '%s' "$out" | grep -Fq "src/ordinary.ts"; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1)); printf 'FAIL parser-refusal-%s-names-source: out<<<%s>>>\n' "$kind" "$out"
	fi
done

repo=$(mkrepo parser-source-unavailable)
printf 'export const source = 1;\n' > "$repo/src/ordinary.ts"
commit_fixture "$repo" "source loader failure is not an empty import set"
oid=$(git -C "$repo" rev-parse HEAD:src/ordinary.ts)
prefix=$(printf '%s' "$oid" | cut -c1-2)
suffix=$(printf '%s' "$oid" | cut -c3-)
mv "$repo/.git/objects/$prefix/$suffix" "$TMP/held-source-blob.$oid"
expect_guard parser-source-unavailable "$repo" 4 "src/ordinary.ts"

for kind in import-equals export-type; do
	repo=$(mkrepo "lexical-real-$kind")
	case "$kind" in
		import-equals) code='import Missing = require("./missing-equals");'; needle=missing-equals ;;
		export-type) code='export type { Missing } from "./missing-export-type";'; needle=missing-export-type ;;
	esac
	printf '%s\n' "$code" > "$repo/src/ordinary.ts"
	commit_fixture "$repo" "real $kind dependency stays checked"
	expect_guard "lexical-real-$kind" "$repo" 4 "$needle"
done

# Parser admission names the exact trusted compiler and ignores Node injections.
repo=$(mkrepo parser-info)
printf 'require("node:fs").writeFileSync(%s, "executed");\n' "\"$repo/injected\"" > "$repo/inject.cjs"
out=$(NODE_OPTIONS="--require=$repo/inject.cjs" NODE_PATH="$repo" sh "$CHECKER" --parser-info --repo "$repo" 2>&1)
rc=$?
printf 'parser-info: rc=%s out<<<%s>>>\n' "$rc" "$out"
if [ "$rc" = 0 ] && [ ! -e "$repo/injected" ] &&
	python3 - "$out" "$repo" <<'PY'
import json, pathlib, re, sys
info = json.loads(sys.argv[1])
module = pathlib.Path(info["module_path"])
assert info["parser"] == "typescript" and isinstance(info["version"], str) and info["version"]
assert module.is_absolute() and pathlib.Path(sys.argv[2]) not in module.parents
assert re.fullmatch("[0-9a-f]{64}", info["module_sha256"])
PY
then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL parser-info\n'
fi

# A candidate-provided compiler may not be loaded, even to inspect its API.
mkdir -p "$repo/toolchain/bin" "$repo/toolchain/lib"
printf '#!/bin/sh\nexit 99\n' > "$repo/toolchain/bin/tsc"
chmod +x "$repo/toolchain/bin/tsc"
cp "$repo/inject.cjs" "$repo/toolchain/lib/typescript.js"
commit_fixture "$repo" "candidate compiler is not a host parser"
out=$(PATH="$repo/toolchain/bin:$PATH" sh "$CHECKER" --parser-info --repo "$repo" 2>&1)
rc=$?
printf 'parser-inside-target: rc=%s out<<<%s>>>\n' "$rc" "$out"
if [ "$rc" = 4 ] && [ ! -e "$repo/injected" ] && printf '%s' "$out" | grep -Fq PARSER_INSIDE_TARGET; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL parser-inside-target\n'
fi

out=$(PATH="$TMP/absent-bin" /bin/sh "$CHECKER" --parser-info 2>&1)
rc=$?
printf 'parser-unavailable: rc=%s out<<<%s>>>\n' "$rc" "$out"
if [ "$rc" = 4 ] && printf '%s' "$out" | grep -Fq PARSER_UNAVAILABLE; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL parser-unavailable\n'
fi

out=$(sh "$CHECKER" --parser-info --repo "$repo" --base HEAD --tip HEAD 2>&1)
rc=$?
printf 'parser-mixed-modes: rc=%s out<<<%s>>>\n' "$rc" "$out"
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -Fq "cannot mix modes"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL parser-mixed-modes\n'
fi

printf 'commit-imports: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]

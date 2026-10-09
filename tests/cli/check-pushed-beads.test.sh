#!/bin/sh
# check-pushed-beads.test.sh — COMMIT1 pre-push bead check contract (ompkit-2w7h).
# A fixture repo with real git objects: good commits pass, a bad-message
# commit is refused naming its sha, including one made by commit-tree (no
# working tree involved). A stub `br` answers show <id>.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/check-pushed-beads.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/check-pushed-beads-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

mkdir -p "$TMP/bin"
cat > "$TMP/bin/br" <<EOF
#!/bin/sh
id=""
for arg in "\$@"; do id="\$arg"; done
case " \$KNOWN_IDS " in
	*" \$id "*) exit 0 ;;
	*) exit 3 ;;
esac
EOF
chmod +x "$TMP/bin/br"
export PATH="$TMP/bin:/usr/bin:/bin"
export KNOWN_IDS="ompkit-2w7h rz5.128"

FIXTURE="$TMP/repo"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init -q 2>/dev/null
git -C "$FIXTURE" config user.email "test@invalid.example"
git -C "$FIXTURE" config user.name "Test"
git -C "$FIXTURE" commit -q --no-verify --allow-empty --message "root" 2>/dev/null
echo "file" > "$FIXTURE/file.txt"
git -C "$FIXTURE" add file.txt
git -C "$FIXTURE" commit -q --no-verify --message "wire the loop ompkit-2w7h" 2>/dev/null
GOOD=$(git -C "$FIXTURE" rev-parse HEAD)
ROOT=$(git -C "$FIXTURE" rev-parse "$GOOD^")
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$ROOT"
TREE=$(git -C "$FIXTURE" rev-parse "$GOOD^{tree}")
PLANTED=$(git -C "$FIXTURE" commit-tree "$TREE" -p "$GOOD" -m "quiet tweak with no id" 2>/dev/null)

run_case() {
	name=$1
	want_rc=$2
	shift 2
	got_rc=0
	sh "$CHECK" "$@" > "$TMP/stdout" 2> "$TMP/stderr" || got_rc=$?
	if [ "$got_rc" = "$want_rc" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s err<<<%s>>>\n' "$name" "$got_rc" "$want_rc" "$(cat "$TMP/stderr")"; fi
}

DB="$TMP/beads.db"
: > "$DB"
export BEADS_DB="$DB"
export BR_BIN="$TMP/bin/br"

# 1. range with only good commits passes
run_case good-range 0 --repo "$FIXTURE" --base "$ROOT" --tip "$GOOD" --db "$DB" --br "$TMP/bin/br"
# 2. planted commit-tree commit with no id is refused naming its sha
out=$(sh "$CHECK" --repo "$FIXTURE" --base "$GOOD" --tip "$PLANTED" --db "$DB" --br "$TMP/bin/br" 2>&1); rc=$?
if [ "$rc" = "4" ] && printf '%s' "$out" | grep -q "$PLANTED"; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL planted-tree: rc=%s out<<<%s>>>\n' "$rc" "$out"; fi
# 3. missing args refused
run_case missing-args 2 --repo "$FIXTURE"
# 4. unknown tip refused
run_case bad-tip 2 --repo "$FIXTURE" --base "$ROOT" --tip deadbeef --db "$DB" --br "$TMP/bin/br"

# 5. an origin/main commit without a bead is outside the pushed set
ORIGIN_FIXTURE="$TMP/origin-range"
mkdir -p "$ORIGIN_FIXTURE"
git -C "$ORIGIN_FIXTURE" init -q 2>/dev/null
git -C "$ORIGIN_FIXTURE" config user.email "test@invalid.example"
git -C "$ORIGIN_FIXTURE" config user.name "Test"
git -C "$ORIGIN_FIXTURE" commit -q --no-verify --allow-empty --message "root without bead" 2>/dev/null
ORIGIN_BASE=$(git -C "$ORIGIN_FIXTURE" rev-parse HEAD)
echo "main baseline" > "$ORIGIN_FIXTURE/file.txt"
git -C "$ORIGIN_FIXTURE" add file.txt
git -C "$ORIGIN_FIXTURE" commit -q --no-verify --message "origin main baseline without bead" 2>/dev/null
ORIGIN_MAIN=$(git -C "$ORIGIN_FIXTURE" rev-parse HEAD)
git -C "$ORIGIN_FIXTURE" update-ref refs/remotes/origin/main "$ORIGIN_MAIN"
echo "valid candidate" > "$ORIGIN_FIXTURE/file.txt"
git -C "$ORIGIN_FIXTURE" add file.txt
git -C "$ORIGIN_FIXTURE" commit -q --no-verify --message "candidate ompkit-2w7h" 2>/dev/null
ORIGIN_TIP=$(git -C "$ORIGIN_FIXTURE" rev-parse HEAD)
run_case origin-main-without-bead 0 --repo "$ORIGIN_FIXTURE" --base "$ORIGIN_BASE" --tip "$ORIGIN_TIP" --db "$DB" --br "$TMP/bin/br"
# 6. a new bead-less commit remains refused and is identified
echo "bad candidate" > "$ORIGIN_FIXTURE/file.txt"
git -C "$ORIGIN_FIXTURE" add file.txt
git -C "$ORIGIN_FIXTURE" commit -q --no-verify --message "new commit with no bead" 2>/dev/null
NEW_BAD=$(git -C "$ORIGIN_FIXTURE" rev-parse HEAD)
out=$(sh "$CHECK" --repo "$ORIGIN_FIXTURE" --base "$ORIGIN_BASE" --tip "$NEW_BAD" --db "$DB" --br "$TMP/bin/br" 2>&1); rc=$?
if [ "$rc" = "4" ] && printf '%s' "$out" | grep -q "$NEW_BAD"; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL new-idless: rc=%s out<<<%s>>>\n' "$rc" "$out"; fi

printf 'check-pushed-beads: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]

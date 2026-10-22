#!/bin/sh
# verify-bump-cert.test.sh — fp72.65 bump-certification proof contract (ompkit-fp72.65).
# Fixture receipt.json files drive the verifier; every verdict comes from its
# exit code plus stdout. Planted: a receipt for another SHA or version refuses.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/verify-bump-cert.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP verify-bump-cert-test || exit 1

SHA_BUMP="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_OTHER="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

pass=0
fail=0
run_case() {
	name=$1
	want_rc=$2
	shift 2
	out="$(sh "$CHECK" --version 0.2.33 --sha "$SHA_BUMP" --receipts "$TMP/receipts" 2>&1)"
	got_rc=$?
	ok=1
	[ "$got_rc" = "$want_rc" ] || ok=0
	for want in "$@"; do
		printf '%s\n' "$out" | grep -qF "$want" || ok=0
	done
	if [ "$ok" = "1" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s out<<<%s>>>\n' "$name" "$got_rc" "$out"; fi
}

setup() {
	rm -rf "$TMP/receipts"
	mkdir -p "$TMP/receipts/darwin-arm64-none-certified" "$TMP/receipts/linux-x64-gnu-minimum"
}

# 1. receipts recording the bump verify
setup
printf '{"schema_version": 1, "version": "0.2.33", "source_sha": "%s"}' "$SHA_BUMP" > "$TMP/receipts/darwin-arm64-none-certified/receipt.json"
printf '{"schema_version": 1, "version": "0.2.33", "source_sha": "%s"}' "$SHA_BUMP" > "$TMP/receipts/linux-x64-gnu-minimum/receipt.json"
run_case match 0 "CERT=verified version=0.2.33" "receipts=2"

# 2. planted: a receipt for another SHA refuses
setup
printf '{"schema_version": 1, "version": "0.2.33", "source_sha": "%s"}' "$SHA_BUMP" > "$TMP/receipts/darwin-arm64-none-certified/receipt.json"
printf '{"schema_version": 1, "version": "0.2.33", "source_sha": "%s"}' "$SHA_OTHER" > "$TMP/receipts/linux-x64-gnu-minimum/receipt.json"
run_case mismatch-sha 4 "does not record bump"

# 3. planted: a receipt for another version refuses
setup
printf '{"schema_version": 1, "version": "0.2.33", "source_sha": "%s"}' "$SHA_BUMP" > "$TMP/receipts/darwin-arm64-none-certified/receipt.json"
printf '{"schema_version": 1, "version": "0.2.32", "source_sha": "%s"}' "$SHA_BUMP" > "$TMP/receipts/linux-x64-gnu-minimum/receipt.json"
run_case mismatch-version 4 "does not record bump"

# 4. planted: an empty receipt set refuses
setup
run_case no-receipts 4 "no native receipts"

# 5. bad sha fails loud
setup
out="$(sh "$CHECK" --version 0.2.33 --sha xyz --receipts "$TMP/receipts" 2>&1)"
if [ "$?" = "2" ]; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL bad-sha: rc=%s out<<<%s>>>\n' "$?" "$out"; fi

printf 'verify-bump-cert: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

#!/bin/sh
# SAVEFIRST1 component control: exercise the pre-push pressure signal and the full-suite
# guard's refusal on this intentionally incomplete local fixture. This is not AC1's actual
# publication proof; the native publisher must establish that boundary.
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -eu

KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
REPO_TMP="$KITREPO/var/agent-tmp"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITREPO/scripts/kitlib-tmp.sh"
# shellcheck disable=SC2034
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP savefirst-pre-push || exit 1

SOURCE_ROOT=${OMP_KIT_CASE_CWD:-$KITREPO}
SOURCE_IDENTITY=$(bun "$KITREPO/scripts/exact-source.ts" --root "$SOURCE_ROOT") || {
	printf 'FAIL SAVEFIRST1 fixture: no exact source identity at %s (clean checkout or stamped archive export)\n' "$SOURCE_ROOT" >&2
	exit 1
}
SOURCE="$TMP/exact-source"
mkdir -p "$SOURCE"
if [ "$SOURCE_IDENTITY" = "GIT" ]; then
	git -C "$SOURCE_ROOT" rev-parse --show-toplevel >/dev/null 2>&1 || {
		printf 'FAIL SAVEFIRST1 fixture: no Git source checkout at %s\n' "$SOURCE_ROOT" >&2
		exit 1
	}
	SOURCE_SHA=$(git -C "$SOURCE_ROOT" rev-parse HEAD) || exit 1
	git -C "$SOURCE_ROOT" archive --format=tar "$SOURCE_SHA" \
		scripts/pre-push-gate.sh scripts/fresh-gate.sh scripts/gate-disk-floor.ts scripts/affected-tests.ts scripts/full-suite-verdict.sh \
		scripts/suite-metrics.py scripts/kitlib_run.py scripts/pysafe.py scripts/kitlib-tmp.sh scripts/test-budget.ts .github/test-budget.json \
		src/heavy.ts src/disk-stage.ts src/state-root.ts src/kitlib/io.ts src/kitlib/proc.ts src/kitlib/run.ts src/mutations.ts src/regex-guards.ts \
		config/heavy-labels.json \
		> "$TMP/exact-source.tar"
else
	(
		cd "$SOURCE_ROOT" || exit 1
		tar -cf "$TMP/exact-source.tar" \
			scripts/pre-push-gate.sh scripts/fresh-gate.sh scripts/gate-disk-floor.ts scripts/affected-tests.ts scripts/full-suite-verdict.sh \
			scripts/suite-metrics.py scripts/kitlib_run.py scripts/pysafe.py scripts/kitlib-tmp.sh scripts/test-budget.ts .github/test-budget.json \
			src/heavy.ts src/disk-stage.ts src/state-root.ts src/kitlib/io.ts src/kitlib/proc.ts src/kitlib/run.ts src/mutations.ts src/regex-guards.ts \
			config/heavy-labels.json
	)
fi
tar -xf "$TMP/exact-source.tar" -C "$SOURCE"
tar -cf "$TMP/source-subset.tar" -C "$SOURCE" scripts src config/heavy-labels.json .github/test-budget.json

make_checker_controls() {
	repo=$1
	for name in publishability.test.sh doc-drift.test.sh derived-check.test.sh dispatch-check.test.sh br-shim.test.sh public-files.test.sh commit-msg-bead.test.sh check-pushed-beads.test.sh release-train.test.sh check-staged-br-init.test.sh; do
		printf '#!/bin/sh\nprintf "CHECKER-PASS: %s\\n"\n' "$name" > "$repo/tests/cli/$name"
		chmod +x "$repo/tests/cli/$name"
	done
}

prepare_fixture() {
	sf_repo=$1
	sf_remote=$2
	sf_max_wait=$3
	mkdir -p "$sf_repo/scripts" "$sf_repo/src" "$sf_repo/tests/cli" "$sf_repo/rules" "$sf_repo/config/omp-kit" "$sf_repo/var/agent-tmp/savefirst-top-owner.1" "$sf_repo/home" "$sf_bin"
	tar -xf "$TMP/source-subset.tar" -C "$sf_repo"
	if [ -n "${OMP_KIT_TEST_GATE_OVERRIDE:-}" ]; then
		cp "$OMP_KIT_TEST_GATE_OVERRIDE" "$sf_repo/scripts/pre-push-gate.sh"
		chmod +x "$sf_repo/scripts/pre-push-gate.sh"
	fi

	# Explicit reaper control: explicit statfs admission must not invoke the sbh percentage reaper.
	cat > "$sf_repo/src/service.ts" <<'SERVICE'
export type ServiceRunner = (args: readonly string[]) => { code: number; stdout: string; stderr: string };
export function runScratchPressureTrigger(): never {
	throw new Error("SAVEFIRST fixture: statfs admission must not invoke the percentage reaper");
}
SERVICE

	# The minimal CLI exposes only the real runHeavy implementation used by the production gate.
	cat > "$sf_repo/src/cli.ts" <<'CLI'
import process from "node:process";
import { runHeavy } from "./heavy.ts";
function registerCommandHandler(_name: string, _handler: () => void): void {}
registerCommandHandler("heavy", () => {});
const commandIndex = process.argv.findIndex((arg, index) => index > 0 && (arg === "--version" || arg === "heavy"));
const args = commandIndex < 0 ? [] : process.argv.slice(commandIndex);
if (args[0] === "--version") {
	console.log("savefirst-fixture 1");
} else if (args[0] === "heavy" && args[1] === "--help") {
	console.log("heavy fixture help");
} else if (args[0] !== "heavy") {
	process.stderr.write("fixture CLI: expected heavy\n");
	process.exitCode = 2;
} else {
	const separator = args.indexOf("--");
	const flags = args.slice(1, separator < 0 ? args.length : separator);
	const command = separator < 0 ? [] : args.slice(separator + 1);
	const labelAt = flags.indexOf("--label");
	const observerAt = flags.indexOf("--disk-observer");
	process.exitCode = await runHeavy(command, {
		noWait: flags.includes("--no-wait"),
		...(labelAt >= 0 ? { label: flags[labelAt + 1] } : {}),
		...(observerAt >= 0 ? { diskObserver: flags[observerAt + 1] } : {}),
	});
}
CLI

	# The real gate requires these files. Their unrelated checks are controls, not claimed evidence.
	printf '#!/bin/sh\nexit 0\n' > "$sf_repo/scripts/build-manifest.sh"
	printf '#!/bin/sh\nexit 0\n' > "$sf_repo/scripts/check-pushed-notes.sh"
	printf 'console.log("README-CONTROL");\n' > "$sf_repo/scripts/readme-check.ts"
	printf 'console.log("TTSR-CONTROL");\n' > "$sf_repo/scripts/ttsr-harness.ts"
	printf 'console.log(["minimal", "always"].join(String.fromCharCode(9)));\n' > "$sf_repo/scripts/rule-class.ts"
	printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$sf_repo/scripts/regexploit-gate.py"
	printf '# fixture rule\n' > "$sf_repo/rules/minimal.md"
	rule_sha=$(shasum -a 256 "$sf_repo/rules/minimal.md" | cut -d' ' -f1)
	printf 'name\tsha256\tclass\tpack\nminimal\t%s\talways\tfixture\n' "$rule_sha" > "$sf_repo/MANIFEST.tsv"
	printf '{"slots":8,"max_wait_s":%s,"disk_observer":"auto"}\n' "$sf_max_wait" > "$sf_repo/config/omp-kit/load.json"
	make_checker_controls "$sf_repo"
	printf 'label=savefirst-top-owner\npid=%s\nrepo=%s\ncreated=%s\n' "$$" "$sf_repo" "$(date -u +%FT%TZ)" > "$sf_repo/var/agent-tmp/savefirst-top-owner.1/.owner"
	dd if=/dev/zero of="$sf_repo/var/agent-tmp/savefirst-top-owner.1/blob" bs=1024 count=4096 2>/dev/null

	printf '#!/bin/sh\nprintf "BASE-BOUNDARY\\n"\n' > "$sf_repo/tests/cli/savefirst-boundary.test.sh"
	chmod +x "$sf_repo/tests/cli/savefirst-boundary.test.sh"
	# The incomplete fixture the full-suite verifier must refuse: one Bun file in the complement that
	# defines no test, so the suite records no Bun summary for it (bun_count 1, bun_ran 0).
	printf '// SAVEFIRST1 fixture: deliberately defines no test.\nexport {};\n' > "$sf_repo/tests/cli/savefirst-incomplete.test.ts"
	git -C "$sf_repo" init -q --initial-branch=main
	git -C "$sf_repo" config user.email "test@example.invalid"
	git -C "$sf_repo" config user.name "SaveFirstFixture"
	git -C "$sf_repo" config core.hooksPath "$sf_repo/.git/hooks"
	git -C "$sf_repo" add -- scripts src tests/cli rules MANIFEST.tsv config/omp-kit/load.json config/heavy-labels.json .github/test-budget.json
	git -C "$sf_repo" commit -qm "[test] SaveFirst minimal gate base"
	git init -q --bare --initial-branch=main "$sf_remote"
	git -C "$sf_repo" remote add origin "$sf_remote"
	sf_base_push_rc=0
	git -C "$sf_repo" push -q origin main > "$TMP/$(basename "$sf_repo")-baseline.out" 2>&1 || sf_base_push_rc=$?
	sf_base=$(git -C "$sf_repo" rev-parse HEAD)
	sf_before=$(git --git-dir="$sf_remote" rev-parse --verify refs/heads/main 2>/dev/null) || sf_before=
	cat > "$sf_repo/tests/cli/savefirst-boundary.test.sh" <<'BOUNDARY'
#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
mkdir -p "$root/var/agent-tmp"
marker="$root/var/agent-tmp/savefirst-boundary.$$"
rm -f "$marker"
bun run --no-env-file --config=/dev/null src/cli.ts heavy --label savefirst-boundary --disk-observer statfs -- touch "$marker"
test -f "$marker"
rm -f "$marker"
printf 'SAVEFIRST-BOUNDARY-TEST PASS\n'
BOUNDARY
	chmod +x "$sf_repo/tests/cli/savefirst-boundary.test.sh"
	git -C "$sf_repo" add -- tests/cli/savefirst-boundary.test.sh
	git -C "$sf_repo" commit -qm "[test] SaveFirst actual caller candidate" -m "Bead: ompkit-774u.16"
	sf_head=$(git -C "$sf_repo" rev-parse HEAD)
	cat > "$sf_repo/.git/hooks/pre-push" <<'HOOK'
#!/bin/sh
exec sh "$SAVEFIRST_FIXTURE_REPO/scripts/pre-push-gate.sh"
HOOK
	chmod +x "$sf_repo/.git/hooks/pre-push"
}

make_sbh() {
	sf_bin=$1
	mkdir -p "$sf_bin"
	cat > "$sf_bin/sbh" <<'SBH'
#!/bin/sh
if [ "$1 $2 $3" = "check --need 10G" ]; then
	printf '%s\n' '{"command":"check","exit_code":1,"free_pct":11.7}'
	exit 1
fi
exit 0
SBH
	chmod +x "$sf_bin/sbh"
}

push_fixture() {
	sf_name=$1
	sf_repo=$2
	sf_remote=$3
	sf_outfile=$4
	sf_rc=0
	SAVEFIRST_FIXTURE_REPO="$sf_repo" HOME="$sf_repo/home" XDG_CONFIG_HOME="$sf_repo/config" \
		XDG_STATE_HOME="$sf_repo/state" XDG_DATA_HOME="$sf_repo/data" XDG_CACHE_HOME="$sf_repo/cache" \
		TMPDIR="$TMP" OMP_KIT_DISK_OBSERVER="" OMP_KIT_HEAVY_FAKE_LOAD1=0.5 \
		FULL_SUITE_TIMEOUT_SECS=60 AGENT_NAME=SaveFirstProbe TMUX_PANE="" PATH="$sf_bin:$PATH" \
		git -C "$sf_repo" push origin main > "$sf_outfile" 2>&1 || sf_rc=$?
	sf_after=$(git --git-dir="$sf_remote" rev-parse --verify refs/heads/main 2>/dev/null) || sf_after=
	printf 'SAVEFIRST1 fixture gate %s push_rc=%s base=%s head=%s origin_after=%s\n' \
		"$sf_name" "$sf_rc" "$sf_base" "$sf_head" "$sf_after"
	while IFS= read -r sf_line || [ -n "$sf_line" ]; do
		printf 'SAVEFIRST1 nested: %s\n' "$sf_line"
	done < "$sf_outfile"
}

sf_bin="$TMP/savefirst-sbh"
make_sbh "$sf_bin"

# Component control: pressure warning and statfs admission must pass, while the full-suite verifier must refuse this incomplete fixture.
high_repo=
KITLIB_TMP_ROOT="$TMP"
kitlib_tmp high_repo savefirst-positive || exit 1
KITLIB_TMP_ROOT="$REPO_TMP"
sf_repo=$high_repo
sf_remote="$TMP/savefirst-positive-origin.git"
prepare_fixture "$sf_repo" "$sf_remote" 5
high_out="$TMP/savefirst-positive.out"
push_fixture pressure-control "$sf_repo" "$sf_remote" "$high_out"
sf_high_rc=$sf_rc
sf_high_after=$sf_after
if [ "$sf_base_push_rc" = 0 ] && [ "$sf_before" = "$sf_base" ] && [ "$sf_high_rc" -ne 0 ] && [ "$sf_high_after" = "$sf_base" ] \
	&& grep -Fq 'WARN disk-pressure: sbh reports 11.7% free' "$high_out" \
	&& grep -Fq 'top_scratch=savefirst-top-owner:' "$high_out" \
	&& grep -Fq 'FRESH-GATE: GREEN' "$high_out" \
	&& grep -Fq 'SAVEFIRST-BOUNDARY-TEST PASS' "$high_out" \
	&& grep -Fq 'FULL-SUITE: RED: full suite ended without complete evidence' "$high_out"; then
	printf 'PASS SAVEFIRST1 component control: pressure warned, statfs step ran, incomplete fixture refused, local origin unchanged\n'
else
	printf 'FAIL SAVEFIRST1 component control: base_rc=%s push_rc=%s before=%s base=%s after=%s head=%s\n' \
		"$sf_base_push_rc" "$sf_high_rc" "$sf_before" "$sf_base" "$sf_high_after" "$sf_head" >&2
	exit 1
fi
if [ "${OMP_KIT_CHECKER_CONTRACT_DRIFT_PROBE:-0}" = 1 ]; then
	printf 'checker-contract fixture control PASS\n'
	exit 0
fi

# Negative: use a genuine <10 GiB statfs root (APFS supplied by the test runner on macOS, /dev/shm on Linux).
low_root=${OMP_KIT_TEST_LOW_FS_DIR:-}
if [ -z "$low_root" ] && [ "$(uname -s)" = Linux ] && [ -d /dev/shm ]; then low_root=/dev/shm; fi
if [ -n "$low_root" ] && [ -d "$low_root" ]; then
	df_output=$(df -k "$low_root")
	low_free_kb=$(printf '%s\n' "$df_output" | awk 'END { print $4 }')
	if [ "$low_free_kb" -lt 10485760 ]; then
		low_repo=
		KITLIB_TMP_ROOT="$low_root"
		kitlib_tmp low_repo savefirst-lowfs || exit 1
		KITLIB_TMP_ROOT="$TMP"
		sf_repo=$low_repo
		sf_remote="$TMP/savefirst-lowfs-origin.git"
		prepare_fixture "$sf_repo" "$sf_remote" 5
		low_out="$TMP/savefirst-lowfs.out"
		push_fixture lowfs "$sf_repo" "$sf_remote" "$low_out"
		if [ "$sf_base_push_rc" = 0 ] && [ "$sf_before" = "$sf_base" ] && [ "$sf_rc" -ne 0 ] && [ "$sf_after" = "$sf_base" ] \
			&& grep -Fq 'heavy: REFUSED reason=DISK_BELOW_FLOOR need=10G' "$low_out" \
			&& grep -Fq 'FRESH-GATE: RED: heavy refused admission for cli-compile' "$low_out" \
			&& grep -Fq 'free at least 10 GiB' "$low_out" && ! grep -Fq 'SAVEFIRST-BOUNDARY-TEST PASS' "$low_out"; then
			printf 'PASS SAVEFIRST1 actual pre-push low-space negative: typed refusal, no child, origin unchanged\n'
		else
			printf 'FAIL SAVEFIRST1 actual pre-push low-space negative: base_rc=%s push_rc=%s before=%s base=%s after=%s\n' \
				"$sf_base_push_rc" "$sf_rc" "$sf_before" "$sf_base" "$sf_after" >&2
			exit 1
		fi
	else
		printf 'SKIP SAVEFIRST1 actual pre-push low-space negative: %s has %s KiB available, not below 10 GiB\n' "$low_root" "$low_free_kb"
	fi
else
	printf 'SKIP SAVEFIRST1 actual pre-push low-space negative: set OMP_KIT_TEST_LOW_FS_DIR to a mounted filesystem below 10 GiB\n'
fi

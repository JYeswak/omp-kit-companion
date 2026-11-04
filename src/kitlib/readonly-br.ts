// readonly-br.ts — REPLAYBR1: per-run read-only br dispatch for verify replays.
//
// A replayed command inherits whatever tracker authority the invoking shell
// carries (including a writable production BEADS_DB). Deleting BEADS_DB is
// not isolation: br falls back to a global default tracker. This module
// builds a per-run `br` shim that is prepended to the replay PATH:
// reads pass through to the real br; writes require an explicitly owned
// database or a local fixture database physically inside the owned root.
// An inherited tracker outside that root is never a write target.
//
// The shim is shell (no new runtime dependency) with the real br path and
// the owned root baked in at install time, so it keeps working for
// env-stripped children. Unknown future mutators refuse closed.
import { accessSync, chmodSync, closeSync, constants, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

export const READONLY_BR_MARKER = "READONLY_TRACKER";
export const READONLY_BR_EXIT = 77;

const SHIM_TEMPLATE = `#!/bin/sh
# GENERATED read-only br dispatch for verify replays (REPLAYBR1). Do not edit.
REAL_BR='@@REAL_BR@@'
ROOT='@@ROOT@@'
MARKER='READONLY_TRACKER'
RC=77
deny() {
	printf '%s: refusing %s (writes require an owned tracker under %s); unmet prerequisite: owned tracker binding\n' "$MARKER" "$1" "$ROOT" >&2
	exit $RC
}
DB=""
HAS_DB_ARG=0
SUB=""
SUB2=""
PREV=""
for arg in "$@"; do
	if [ -n "$PREV" ]; then
		if [ "$PREV" = "--db" ]; then DB="$arg"; HAS_DB_ARG=1; fi
		PREV=""
		continue
	fi
	case "$arg" in
		--db) PREV="--db"; HAS_DB_ARG=1 ;;
		--db=*) DB="$arg"; HAS_DB_ARG=1 ;;
		--actor|--format|--limit|--offset|--sort|--since|--until) PREV="$arg" ;;
		--*) ;;
		*) if [ -z "$SUB" ]; then SUB="$arg"; elif [ -z "$SUB2" ]; then SUB2="$arg"; fi ;;
	esac
done
case "$DB" in
	--db=*) DB=\${DB#--db=} ;;
esac
case "$SUB" in
	""|help|version) exec "$REAL_BR" "$@" ;;
esac
ROOT_PHYS=$(cd "$ROOT" 2>/dev/null && pwd -P) || deny "root $ROOT"
path_under_root() {
	CHECK_PATH=$1
	case "$CHECK_PATH" in
		/*) ;;
		*) CHECK_PATH="$PWD/$CHECK_PATH" ;;
	esac
	case "$CHECK_PATH" in
		*"/../"*|*"/./"*|*"//"*) return 1 ;;
	esac
	if [ -L "$CHECK_PATH" ]; then return 1; fi
	CHECK_PARENT=$(dirname "$CHECK_PATH") || return 1
	while [ ! -d "$CHECK_PARENT" ]; do
		CHECK_NEXT=$(dirname "$CHECK_PARENT") || return 1
		[ "$CHECK_NEXT" != "$CHECK_PARENT" ] || return 1
		CHECK_PARENT="$CHECK_NEXT"
	done
	CHECK_PARENT=$(cd "$CHECK_PARENT" 2>/dev/null && pwd -P) || return 1
	case "$CHECK_PARENT/" in
		"$ROOT_PHYS/"*) return 0 ;;
	esac
	return 1
}
if [ "$HAS_DB_ARG" = "0" ]; then
	LOCAL_DB="$PWD/.beads/beads.db"
	if [ -f "$LOCAL_DB" ] && [ ! -L "$LOCAL_DB" ] && path_under_root "$LOCAL_DB"; then
		if [ -z "$BEADS_DB" ] || ! path_under_root "$BEADS_DB"; then
			BEADS_DB="$LOCAL_DB"
			export BEADS_DB
		fi
	fi
fi
if [ "$SUB" = "init" ]; then
	if [ -n "$DB" ]; then
		path_under_root "$DB" || deny "init database $DB"
		exec "$REAL_BR" "$@"
	fi
	TGT="$SUB2"
	if [ -z "$TGT" ]; then TGT="."; fi
	case "$TGT" in
		/*) ABS="$TGT" ;;
		.) ABS="$PWD" ;;
		*) ABS="$PWD/$TGT" ;;
	esac
	INIT_DB="$ABS/.beads/beads.db"
	path_under_root "$INIT_DB" || deny "init $TGT"
	BEADS_DB="$INIT_DB"
	export BEADS_DB
	exec "$REAL_BR" "$@"
fi
EFF="$DB"
if [ -z "$EFF" ]; then EFF="$BEADS_DB"; fi
if [ -n "$EFF" ] && path_under_root "$EFF"; then
	exec "$REAL_BR" "$@"
fi
case "$SUB" in
	comments|dep|gate|label|epic|config|query|audit)
		case " $SUB " in
			" comments ") ALLOW=" list help " ;;
			" dep ") ALLOW=" list tree cycles help " ;;
			" gate ") ALLOW=" list help " ;;
			" label ") ALLOW=" list list-all help " ;;
			" epic ") ALLOW=" status help " ;;
			" config ") ALLOW=" list get schema path help " ;;
			" query ") ALLOW=" list run help " ;;
			" audit ") ALLOW=" log summary help " ;;
		esac
		case " $ALLOW " in
			*" $SUB2 "*) exec "$REAL_BR" "$@" ;;
		esac
		deny "$SUB $SUB2" ;;
esac
case " blocked capabilities changelog completions count coordination graph info lint list orphans ready robot-docs scheduler schema search show stale stats status vcs-status version where help " in
	*" $SUB "*) exec "$REAL_BR" "$@" ;;
esac
deny "$SUB"
`;

export type RealBrResolution =
	| { ok: true; path: string; skipped: string[] }
	| { ok: false; code: "BR_REAL_ABSENT" | "BR_REAL_SHIM_ONLY"; reason: string; skipped: string[] };

const realOrSelf = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/**
 * SHIMRESOLVE1 (ompkit-fp72.120.16.196): true when `candidate` is the omp-kit pane guard shim.
 * Identity is physical, as SUITESHIMPATH1 (scripts/full-suite-verdict.sh) judges it: the
 * candidate's directory realpath is the agent-bin dir scripts/agent-spawn-env.sh installs
 * ($HOME/.local/share/omp-kit/agent-bin), or the candidate's realpath is a scripts/br-shim.sh.
 * Directories are compared, not file realpaths, so macOS hard-linked stubs (HERMPATH1) never
 * alias; the name `br` alone is never evidence.
 */
export function isKitBrShim(candidate: string, home: string | undefined): boolean {
	if (realOrSelf(candidate).endsWith(`${sep}scripts${sep}br-shim.sh`)) return true;
	if (!home || home === "/") return false;
	const agentBin = join(home, ".local", "share", "omp-kit", "agent-bin");
	return realOrSelf(join(candidate, "..")) === realOrSelf(agentBin);
}

/**
 * Resolve the official br on PATH, skipping the omp-kit pane shim (run before the
 * REPLAYBR1 dir exists on PATH, so no self-match). A PATH whose only br is the shim
 * is BR_REAL_SHIM_ONLY, never the shim.
 */
export function resolveRealBr(searchPath: string | undefined, home: string | undefined = process.env.HOME): RealBrResolution {
	const path = searchPath ?? process.env.PATH ?? "";
	const skipped: string[] = [];
	for (const dir of path.split(":")) {
		if (!dir) continue;
		const cand = join(dir, "br");
		try {
			accessSync(cand, constants.X_OK);
			if (!statSync(cand).isFile()) continue;
		} catch { continue; }
		if (isKitBrShim(cand, home)) { skipped.push(cand); continue; }
		return { ok: true, path: cand, skipped };
	}
	return skipped.length > 0
		? { ok: false, code: "BR_REAL_SHIM_ONLY", reason: `BR_REAL_SHIM_ONLY: every br on PATH is the omp-kit pane shim (${skipped.join(", ")}); unmet prerequisite: official br binary beyond the shim`, skipped }
		: { ok: false, code: "BR_REAL_ABSENT", reason: "BR_REAL_ABSENT: no br on PATH; unmet prerequisite: official br binary", skipped };
}

/** Owned fixture writes must skip policy scripts without changing ambient seat identity. */
export function resolveNativeBr(searchPath: string | undefined): string | null {
	const header = Buffer.alloc(2);
	for (const dir of (searchPath ?? process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, "br");
		let fd: number;
		try {
			accessSync(candidate, constants.X_OK);
			if (!statSync(candidate).isFile()) continue;
			fd = openSync(candidate, "r");
		} catch { continue; }
		try {
			if (readSync(fd, header, 0, 2, 0) === 2 && !(header[0] === 35 && header[1] === 33))
				return realpathSync(candidate);
		} finally { closeSync(fd); }
	}
	return null;
}

/** Write bin/br under scratchDir and return the bin dir to prepend to replay PATH. */
export function installReadonlyBr(scratchDir: string, realBr: string): string {
	const binDir = join(scratchDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const script = SHIM_TEMPLATE.split("@@REAL_BR@@").join(realBr.split("'").join("'\\''")).split("@@ROOT@@").join(scratchDir.split("'").join("'\\''"));
	const dest = join(binDir, "br");
	writeFileSync(dest, script, { mode: 0o755 });
	try { chmodSync(dest, 0o755); } catch { /* non-fatal on odd filesystems */ }
	return binDir;
}

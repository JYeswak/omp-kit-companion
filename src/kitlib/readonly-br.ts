// readonly-br.ts — REPLAYBR1: per-run read-only br dispatch for verify replays.
//
// A replayed command inherits whatever tracker authority the invoking shell
// carries (including a writable production BEADS_DB). Deleting BEADS_DB is
// not isolation: br falls back to a global default tracker. This module
// builds a per-run `br` shim that is prepended to the replay PATH:
// reads pass through to the real br; anything else is refused unless it
// names an explicitly admitted owned tracker, so production state can
// never be mutated through the supported dispatch.
//
// The shim is shell (no new runtime dependency) with the real br path and
// the owned root baked in at install time, so it keeps working for
// env-stripped children. Unknown future mutators refuse closed.
import { accessSync, chmodSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const READONLY_BR_MARKER = "READONLY_TRACKER";
export const READONLY_BR_EXIT = 77;

const SHIM_TEMPLATE = `#!/bin/sh
# GENERATED read-only br dispatch for verify replays (REPLAYBR1). Do not edit.
REAL_BR='@@REAL_BR@@'
ROOT='@@ROOT@@'
MARKER='READONLY_TRACKER'
RC=77
deny() {
	printf '%s: refusing %s (writes only via explicit owned --db under %s); unmet prerequisite: owned tracker binding\\n' "$MARKER" "$1" "$ROOT" >&2
	exit $RC
}
DB=""
SUB=""
SUB2=""
PREV=""
for arg in "$@"; do
	if [ -n "$PREV" ]; then
		if [ "$PREV" = "--db" ]; then DB="$arg"; fi
		PREV=""
		continue
	fi
	case "$arg" in
		--db) PREV="--db" ;;
		--db=*) DB="$arg" ;;
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
if [ "$SUB" = "init" ]; then
	TGT="$SUB2"
	if [ -z "$TGT" ]; then TGT="."; fi
	case "$TGT" in
		/*) ABS="$TGT" ;;
		*) ABS="$PWD/$TGT" ;;
	esac
	case "$ABS/" in
		"$ROOT/"*) exec "$REAL_BR" "$@" ;;
	esac
	deny "init $TGT"
fi
EFF="$DB"
if [ -z "$EFF" ]; then EFF="$BEADS_DB"; fi
if [ -n "$EFF" ]; then
	case "$EFF" in
		*"/../"*|*"/./"*|*"//"*) deny "path $EFF" ;;
	esac
	case "$EFF/" in
		"$ROOT/"*) exec "$REAL_BR" "$@" ;;
	esac
fi
deny "$SUB"
`;

/** Resolve the real br on PATH (run before the shim dir exists on PATH, so no self-match). */
export function resolveRealBr(searchPath: string | undefined): string | null {
	const path = searchPath ?? process.env.PATH ?? "";
	for (const dir of path.split(":")) {
		if (!dir) continue;
		const cand = join(dir, "br");
		try {
			accessSync(cand, constants.X_OK);
			if (statSync(cand).isFile()) return cand;
		} catch { /* next */ }
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

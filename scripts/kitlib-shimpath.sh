# shellcheck shell=sh
# kitlib shimpath: drop the omp-kit agent-bin br shim from PATH (SHIMPATH2, ompkit-fp72.120.16.226).
#
# A seat PATH puts $HOME/.local/share/omp-kit/agent-bin (as agent-spawn-env.sh installs it) first, and
# its br shim refuses every fixture actor (BR_SHIM_ACTOR_MISMATCH), so tests run under it turn red for
# their environment, not their tree. SUITESHIMPATH1 (ompkit-774u.60.1) scrubbed this inside
# release-verdict.sh; fresh-gate.sh needs the same, so the scrub lives here once.
#
# Source it, never execute it:
#
#   . "$SCRIPT_DIR/kitlib-shimpath.sh"
#   kitlib_drop_agent_bin my-label
#
# It removes the agent-bin dir, any entry that is that dir by realpath, and any entry whose br resolves
# to a scripts/br-shim.sh; every other entry keeps its place. It exports the cleaned PATH and prints
# `<label>: PATH sanitized (removed A:B)` on stdout only when it removed something.
kitlib_drop_agent_bin() {
	ksp_agent_bin="${HOME:-}/.local/share/omp-kit/agent-bin"
	ksp_agent_bin_real=$(CDPATH='' cd -- "$ksp_agent_bin" 2>/dev/null && pwd -P) || ksp_agent_bin_real=$ksp_agent_bin
	ksp_path=''
	ksp_removed=''
	ksp_ifs=$IFS
	IFS=:
	for ksp_dir in $PATH; do
		ksp_drop=0
		if [ -n "$ksp_dir" ]; then
			[ "$ksp_dir" = "$ksp_agent_bin" ] && ksp_drop=1
			[ "$(CDPATH='' cd -- "$ksp_dir" 2>/dev/null && pwd -P)" = "$ksp_agent_bin_real" ] && ksp_drop=1
			if [ -f "$ksp_dir/br" ]; then
				case "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$ksp_dir/br")" in
					*/scripts/br-shim.sh) ksp_drop=1 ;;
				esac
			fi
		fi
		if [ "$ksp_drop" = 1 ]; then
			ksp_removed="${ksp_removed:+$ksp_removed:}$ksp_dir"
		else
			ksp_path="${ksp_path:+$ksp_path:}$ksp_dir"
		fi
	done
	IFS=$ksp_ifs
	if [ -n "$ksp_removed" ]; then
		PATH=$ksp_path
		export PATH
		printf '%s: PATH sanitized (removed %s)\n' "$1" "$ksp_removed"
	fi
}

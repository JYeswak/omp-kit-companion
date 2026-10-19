#!/bin/sh
# svcpin probe (ompkit-v66l.26): BTM (backgroundtaskmanagementd) gives a
# notified legacy LaunchAgent a launch requirement (LWCR) pinned to the cdhash
# of the ad-hoc binary it runs. When the symlink behind the program moves to a
# binary with another cdhash (every kit release), the next spawn dies "AMFI:
# Launch Constraint Violation" / OS_REASON_CODESIGNING; launchd logs "Requesting
# LWCR update on next spawn" and the spawn after that succeeds.
#
# Precondition this probe cannot force: the pin exists only once BTM marks the
# item "notified", which posting its "can run in the background" advisory does
# not do by itself (measured 2026-10-18: the disposable label stayed "not
# notified" over four runs, and BTM then logged "Exceeded max notifications"
# for it). Each run posts that advisory, so do not loop this probe. When the
# pin never appears the run is INCONCLUSIVE (exit 3), never a pass.
#
# Fixture, all under --work-dir plus ONE disposable LaunchAgent plist:
#   two ad-hoc (linker-signed) builds of a tiny C program with different
#   cdhashes, A and B; a stable link -> active link -> A (the kit's
#   ~/.local/bin/omp-kit -> ~/.local/opt/omp-kit/bin/omp-kit -> releases/<v>
#   shape); a LaunchAgent with StartInterval 10 running the stable link.
# Steps: bootstrap; wait (up to --pin-wait seconds) for 2 runs of A and for
# BTM to attach its launch requirement; flip the active link to B (the
# activation); observe for --observe seconds; boot the label out and remove
# its plist (also on interrupt).
#
# --launch direct  ProgramArguments[0] is the stable link (the pre-fix kit plist).
# --launch sh      ProgramArguments are /bin/sh -c 'exec "$0" "$@"' LINK tick
#                  (the fix: launchd spawns, and pins, the platform /bin/sh).
# --rebootstrap    after the flip, bootout + bootstrap the label (option B).
# --expect kill    pass when the flip produces a Launch Constraint Violation.
# --expect survive pass when B spawns 2+ times and no violation is logged.
#
# Usage: sh tests/e2e/svcpin-launch-constraint.sh --work-dir ABS
#          --launch direct|sh --expect kill|survive [--rebootstrap]
#          [--label com.omp-kit.test.NAME] [--observe SECONDS] [--pin-wait SECONDS]
# Writes WORK/runs.log (one line per spawn), WORK/launchd.log (`log show`
# excerpt) and WORK/print-*.txt; the final stdout line is one JSON summary.
# Exit: 0 expectation met; 1 not met; 2 usage or fixture error; 3 inconclusive
# (BTM never attached the launch requirement, so nothing was tested).
# macOS only; never addresses a label outside com.omp-kit.test.*.

set -u

WORK="" LAUNCH="" EXPECT="" REBOOT=0 LABEL="com.omp-kit.test.svcpin" OBSERVE=50 PIN_WAIT=300
while [ $# -gt 0 ]; do
	case "$1" in
		--work-dir) WORK="${2:?}"; shift 2 ;;
		--launch) LAUNCH="${2:?}"; shift 2 ;;
		--expect) EXPECT="${2:?}"; shift 2 ;;
		--rebootstrap) REBOOT=1; shift ;;
		--label) LABEL="${2:?}"; shift 2 ;;
		--observe) OBSERVE="${2:?}"; shift 2 ;;
		--pin-wait) PIN_WAIT="${2:?}"; shift 2 ;;
		*) echo "usage: $0 --work-dir ABS --launch direct|sh --expect kill|survive [--rebootstrap] [--label L] [--observe S] [--pin-wait S]" >&2; exit 2 ;;
	esac
done
case "$WORK" in /*) ;; *) echo "needs an absolute --work-dir" >&2; exit 2 ;; esac
case "$LAUNCH" in direct|sh) ;; *) echo "--launch must be direct or sh" >&2; exit 2 ;; esac
case "$EXPECT" in kill|survive) ;; *) echo "--expect must be kill or survive" >&2; exit 2 ;; esac
case "$LABEL" in com.omp-kit.test.?*) ;; *) echo "--label must be com.omp-kit.test.<name>" >&2; exit 2 ;; esac
case "$OBSERVE$PIN_WAIT" in *[!0-9]*|"") echo "--observe and --pin-wait must be whole seconds" >&2; exit 2 ;; esac
[ "$(uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 2; }

DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNS="$WORK/runs.log"
mkdir -p "$WORK/releases/a" "$WORK/releases/b" "$WORK/bin" || exit 2
: > "$RUNS"

cleanup() {
	launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
	rm -f "$PLIST"
}
trap 'cleanup; exit 2' INT TERM HUP
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
	echo "$LABEL is already loaded; refusing to reuse it" >&2; exit 2
fi

# Each spawn appends: variant pid ppid argv1. ppid 1 proves launchd's direct
# child (exec replaced any shell); exit 3 proves the exit code passes through.
cat > "$WORK/svcpin.c" <<'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
	const char *log = getenv("SVCPIN_LOG");
	FILE *f = log ? fopen(log, "a") : NULL;
	if (!f) return 2;
	fprintf(f, "%s %d %d %s\n", VARIANT, (int)getpid(), (int)getppid(), argc > 1 ? argv[1] : "-");
	fclose(f);
	return 3;
}
EOF
cc -O0 -DVARIANT='"A"' -o "$WORK/releases/a/svcpin" "$WORK/svcpin.c" || exit 2
cc -O0 -DVARIANT='"B"' -o "$WORK/releases/b/svcpin" "$WORK/svcpin.c" || exit 2
CDA=$(codesign -dv --verbose=4 "$WORK/releases/a/svcpin" 2>&1 | sed -n 's/^CDHash=//p')
CDB=$(codesign -dv --verbose=4 "$WORK/releases/b/svcpin" 2>&1 | sed -n 's/^CDHash=//p')
if [ -z "$CDA" ] || [ "$CDA" = "$CDB" ]; then echo "fixture needs two distinct cdhashes (A=$CDA B=$CDB)" >&2; exit 2; fi

ln -sfn "$WORK/releases/a/svcpin" "$WORK/bin/active"
ln -sfn "$WORK/bin/active" "$WORK/bin/svcpin"
LINK="$WORK/bin/svcpin"

if [ "$LAUNCH" = sh ]; then
	PROGRAM="<string>/bin/sh</string><string>-c</string><string>exec \"\$0\" \"\$@\"</string><string>$LINK</string><string>tick</string>"
else
	PROGRAM="<string>$LINK</string><string>tick</string>"
fi
write_plist() {
	cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array>$PROGRAM</array>
	<key>EnvironmentVariables</key><dict><key>SVCPIN_LOG</key><string>$RUNS</string><key>SVCPIN_PHASE</key><string>$1</string></dict>
	<key>StartInterval</key><integer>10</integer>
	<key>RunAtLoad</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>WorkingDirectory</key><string>$WORK</string>
</dict>
</plist>
EOF
	plutil -lint "$PLIST" >/dev/null || { cleanup; exit 2; }
}

count() { grep -c "^$1 " "$RUNS"; }
START=$(date '+%Y-%m-%d %H:%M:%S')
write_plist register
launchctl bootstrap "$DOMAIN" "$PLIST" || { cleanup; exit 2; }

# A first bootstrap registers a new item "not notified"; launchd asks for a
# launch requirement ("first run LWCR update", later "repair LWCR update", which
# attaches the BTM uuid: "managed LWCR", and "has LWCR" when it pins the
# program's cdhash) only for an item BTM already marks notified. Give BTM 20 s
# to post its advisory, then rewrite and bootstrap again (the kit's own
# `service install` shape), and flip only once the requirement is attached.
sleep 20
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
write_plist pin
launchctl bootstrap "$DOMAIN" "$PLIST" || { cleanup; exit 2; }
waited=0
while [ $waited -lt "$PIN_WAIT" ]; do
	launchctl print "$DOMAIN/$LABEL" > "$WORK/print-before.txt" 2>&1
	if [ "$(count A)" -ge 2 ] && grep -q "managed LWCR" "$WORK/print-before.txt"; then
		if [ "$LAUNCH" = sh ] || grep -q "has LWCR" "$WORK/print-before.txt"; then break; fi
	fi
	sleep 2; waited=$((waited + 2))
done
A_BEFORE=$(count A)
if grep -q "has LWCR" "$WORK/print-before.txt"; then PINNED=true; else PINNED=false; fi
if grep -q "managed LWCR" "$WORK/print-before.txt"; then MANAGED=true; else MANAGED=false; fi
PROPS=$(sed -n 's/^[[:space:]]*properties = //p' "$WORK/print-before.txt" | head -n 1)
FLIP=$(date '+%Y-%m-%d %H:%M:%S')
ln -sfn "$WORK/releases/b/svcpin" "$WORK/bin/active.new" && mv -f "$WORK/bin/active.new" "$WORK/bin/active"
if [ $REBOOT -eq 1 ]; then
	launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
	launchctl bootstrap "$DOMAIN" "$PLIST" || { cleanup; exit 2; }
fi
sleep "$OBSERVE"
if launchctl print "$DOMAIN/$LABEL" > "$WORK/print-after.txt" 2>&1; then LOADED=true; else LOADED=false; fi
cleanup
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then GONE=false; else GONE=true; fi
sleep 2
# launchd's per-job lines carry the label only in their printed prefix, so
# capture launchd plus the kernel AMFI lines naming this fixture, then keep
# the lines for this label or work dir.
log show --style compact --start "$START" \
	--predicate "process == \"launchd\" OR process == \"smd\" OR eventMessage CONTAINS \"$WORK\"" > "$WORK/log-raw.txt" 2>&1
grep -F -e "$LABEL" -e "$WORK" "$WORK/log-raw.txt" > "$WORK/launchd.log"

B_RUNS=$(count B)
VIOLATIONS=$(grep -c "launchd.*Launch Constraint Violation" "$WORK/launchd.log")
CODESIGNING=$(grep -c "exited with exit reason.*OS_REASON_CODESIGNING" "$WORK/launchd.log")
REMOVED=$(grep -c "removing service since it exited with consistent failure" "$WORK/launchd.log")
PPID_OK=$(awk '$1 == "B" && $3 != 1 { bad = 1 } END { print bad ? "false" : "true" }' "$RUNS")
LAST_EXIT=$(sed -n 's/^[[:space:]]*last exit code = //p' "$WORK/print-after.txt" | head -n 1)

if [ "$MANAGED" != true ] || { [ "$LAUNCH" = direct ] && [ "$PINNED" != true ]; }; then
	VERDICT=INCONCLUSIVE
elif [ "$EXPECT" = kill ]; then
	if [ "$VIOLATIONS" -ge 1 ]; then VERDICT=PASS; else VERDICT=FAIL; fi
elif [ "$B_RUNS" -ge 2 ] && [ "$VIOLATIONS" -eq 0 ] && [ "$CODESIGNING" -eq 0 ] && [ "$PPID_OK" = true ]; then
	VERDICT=PASS
else
	VERDICT=FAIL
fi
printf '{"launch":"%s","rebootstrap":%s,"expect":"%s","verdict":"%s","cdhash_a":"%s","cdhash_b":"%s","properties_before_flip":"%s","managed_before_flip":%s,"pinned_before_flip":%s,"flip":"%s","a_runs_before_flip":%s,"b_runs":%s,"b_parent_is_launchd":%s,"constraint_violations":%s,"codesigning_exits":%s,"removing_service":%s,"loaded_after_observe":%s,"last_exit_after":"%s","label_gone":%s}\n' \
	"$LAUNCH" "$([ $REBOOT -eq 1 ] && echo true || echo false)" "$EXPECT" "$VERDICT" "$CDA" "$CDB" "$PROPS" "$MANAGED" "$PINNED" "$FLIP" "$A_BEFORE" "$B_RUNS" "$PPID_OK" "$VIOLATIONS" "$CODESIGNING" "$REMOVED" "$LOADED" "$LAST_EXIT" "$GONE"
[ "$GONE" = true ] || exit 1
case "$VERDICT" in PASS) exit 0 ;; INCONCLUSIVE) exit 3 ;; *) exit 1 ;; esac

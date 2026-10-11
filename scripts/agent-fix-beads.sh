#!/bin/sh
# agent-fix-beads.sh -- route every open `agent-fix` issue of the companion repo to exactly one bead in the
# omp-kit tracker, so the fleet's Guide loop (br ready) works it; no person has to notice the issue.
#
# usage: agent-fix-beads.sh [--repo OWNER/NAME] [--tracker DIR] [--dry-run]
#   --repo     GitHub repository whose issues are routed (default JYeswak/omp-kit-companion)
#   --tracker  directory holding the beads tracker br runs in (default ~/Developer/omp-kit)
#   --dry-run  print what would be created or noted; write nothing
#
# Idempotent by key: a bead's external_ref is the issue URL, so a rerun (or a crash between steps) never
# creates a second bead for one issue (RoboOMP dedupes its queue the same way: python/robomp/src/queue.py).
# It is a periodic reconcile, not a webhook (python/robomp/src/issue_index.py IssueIndexSync): it runs as the
# control-plane cron lane `omp-companion-agent-fix-beads`, under scheduled-lane-run.sh's lock and deadline.
#   - open agent-fix issue, no bead      -> br create (P1, labels agent-fix,automation) + one issue comment
#   - open agent-fix issue, bead exists  -> nothing
#   - bead whose issue has closed        -> one bead comment naming the close, so the Guide loop can close
#                                           the bead under the tracker's own close guard (never closed here)
# Exit: 0 done (including nothing to do), 1 a gh/br call failed, 2 usage.
set -eu

REPO=JYeswak/omp-kit-companion
TRACKER="$HOME/Developer/omp-kit"
DRY_RUN=0
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ $# -ge 2 ] || { echo "agent-fix-beads: --repo needs a value" >&2; exit 2; }; REPO=$2; shift 2 ;;
		--tracker) [ $# -ge 2 ] || { echo "agent-fix-beads: --tracker needs a value" >&2; exit 2; }; TRACKER=$2; shift 2 ;;
		--dry-run) DRY_RUN=1; shift ;;
		*) echo "usage: agent-fix-beads.sh [--repo OWNER/NAME] [--tracker DIR] [--dry-run]" >&2; exit 2 ;;
	esac
done
[ -d "$TRACKER" ] || { echo "agent-fix-beads: tracker directory missing: $TRACKER" >&2; exit 2; }

CLOSED_NOTE="agent-fix-beads: GitHub issue closed"
issues=$(gh issue list --repo "$REPO" --label agent-fix --state open --limit 200 --json number,title,url) || exit 1
beads=$(cd "$TRACKER" && br list --all --label agent-fix --limit 0 --json) || exit 1
# br list --json is either a bare array or {issues: [...]} depending on version; accept both.
beads=$(printf '%s' "$beads" | jq -c 'if type == "array" then . else .issues end') || exit 1

created=0 tracked=0 noted=0
for row in $(printf '%s' "$issues" | jq -r '.[] | @base64'); do
	issue=$(printf '%s' "$row" | base64 -d)
	url=$(printf '%s' "$issue" | jq -r .url)
	number=$(printf '%s' "$issue" | jq -r .number)
	title=$(printf '%s' "$issue" | jq -r .title)
	existing=$(printf '%s' "$beads" | jq -r --arg url "$url" '[.[] | select(.external_ref == $url) | .id] | first // empty')
	if [ -n "$existing" ]; then
		echo "TRACKED #$number -> $existing"
		tracked=$((tracked + 1))
		continue
	fi
	if [ "$DRY_RUN" = 1 ]; then
		echo "WOULD-CREATE #$number $title"
		continue
	fi
	description=$(printf 'Routed automatically from %s by scripts/agent-fix-beads.sh.\n\nThe issue body holds the findings (why certification is blocked, the code paths, the diffs). Work it in an export of origin/main, land on main via the private-index flow with FRESH-GATE GREEN, and let the workflow that filed the issue close it: omp-certify closes its certification issue when a run passes.' "$url")
	id=$(cd "$TRACKER" && br create --silent --title "agent-fix: $title (#$number)" -t task -p P1 -l agent-fix,automation \
		--external-ref "$url" --description "$description" \
		--acceptance-criteria "The GitHub issue $url is closed by the workflow that filed it (a passing run), with the fixing commit on main named in a comment.") || exit 1
	gh issue comment "$number" --repo "$REPO" \
		--body "Tracked as bead \`$id\` in the omp-kit tracker; the fleet's Guide loop works it from \`br ready\`. This issue still closes itself when the workflow that filed it passes. <!-- agent-fix-bead $id -->" >/dev/null || exit 1
	echo "CREATED #$number -> $id"
	created=$((created + 1))
done

# Beads routed here whose issue has since closed (open/in_progress/blocked): note the close once.
for row in $(printf '%s' "$beads" | jq -r --arg prefix "https://github.com/$REPO/issues/" \
	'.[] | select(.status != "closed" and ((.external_ref // "") | startswith($prefix))) | @base64'); do
	bead=$(printf '%s' "$row" | base64 -d)
	id=$(printf '%s' "$bead" | jq -r .id)
	url=$(printf '%s' "$bead" | jq -r .external_ref)
	state=$(gh issue view "$url" --json state,stateReason,closedAt --jq '"\(.state) \(.stateReason // "") \(.closedAt // "")"') || exit 1
	case "$state" in CLOSED*) ;; *) continue ;; esac
	if (cd "$TRACKER" && br comments list "$id" --json) | jq -e --arg note "$CLOSED_NOTE" 'tostring | contains($note)' >/dev/null; then
		continue
	fi
	if [ "$DRY_RUN" = 1 ]; then
		echo "WOULD-NOTE $id $url $state"
		continue
	fi
	(cd "$TRACKER" && br comments add "$id" --message "$CLOSED_NOTE ($state): $url. Confirm the fix is on main, then close this bead.") >/dev/null || exit 1
	echo "NOTED $id $url $state"
	noted=$((noted + 1))
done
echo "agent-fix-beads: repo=$REPO created=$created tracked=$tracked noted=$noted dry_run=$DRY_RUN"

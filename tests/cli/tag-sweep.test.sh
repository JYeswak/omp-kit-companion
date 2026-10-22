#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
work='' # assigned by kitlib_tmp via eval
kitlib_tmp work tag-sweep || exit 1

# Planted missing control: older tags with no published release are detected and
# recorded as superseded by the nearest newer stable release.
printf '%s\n' v0.2.45 v0.2.47 v0.2.48 > "$work/tags"
printf '%s\n' '[{"tag_name":"v0.2.48"}]' > "$work/releases"
if sh "$ROOT/scripts/tag-sweep.sh" --repo example/kit --tags-file "$work/tags" \
	--releases-file "$work/releases" --release-index "$work/missing-index.json" \
	--receipt "$work/missing.json"; then
	echo 'expected missing release to fail closed' >&2
	exit 1
fi
jq -e '
	.status == "detected" and .resolution == "complete" and .missing_count == 2
	and (.missing | sort == ["v0.2.45","v0.2.47"])
	and ([.entries[] | select(.disposition == "superseded")] | length == 2)
	and ([.entries[] | select(.superseded_by == "v0.2.48")] | length == 2)
' "$work/missing.json" >/dev/null
jq -e '.kind == "tag-release-gap-index" and (.entries | length == 2)' "$work/missing-index.json" >/dev/null

# Planted quiet control: once every tag has a stable release, the checker is quiet.
printf '%s\n' '[{"tag_name":"v0.2.45"},{"tag_name":"v0.2.47"},{"tag_name":"v0.2.48"}]' > "$work/releases-all"
sh "$ROOT/scripts/tag-sweep.sh" --repo example/kit --tags-file "$work/tags" \
	--releases-file "$work/releases-all" --receipt "$work/quiet.json" >/dev/null
jq -e '.status == "quiet" and .missing_count == 0 and .entries == []' "$work/quiet.json" >/dev/null

# A draft release is not visible to self-updaters and must remain a gap until
# a newer stable publication supersedes it.
printf '%s\n' v0.2.56 > "$work/draft-tags"
printf '%s\n' '[{"tag_name":"v0.2.56","draft":true},{"tag_name":"v0.2.57","draft":false,"prerelease":false}]' > "$work/draft-releases"
if sh "$ROOT/scripts/tag-sweep.sh" --repo example/kit --tags-file "$work/draft-tags" \
	--releases-file "$work/draft-releases" --receipt "$work/draft.json" >/dev/null; then
	echo 'expected draft release to remain a detected gap' >&2
	exit 1
fi
jq -e '.missing == ["v0.2.56"] and .entries[0].disposition == "superseded" and .entries[0].superseded_by == "v0.2.57"' "$work/draft.json" >/dev/null

# A successful exact qualification supplies an idempotent release-train
# recovery action for a gap with no newer successor.
printf '%s\n' v0.2.64 > "$work/resume-tags"
printf '%s\n' '[{"tag_name":"v0.2.63"}]' > "$work/resume-releases"
printf '%s\n' '[{"id":12345,"status":"completed","conclusion":"success","display_title":"qualify 0.2.64 abc123 train-99","path":".github/workflows/release.yml","head_branch":"main","head_sha":"abc123"}]' > "$work/runs"
sh "$ROOT/scripts/tag-sweep.sh" --repo example/kit --tags-file "$work/resume-tags" \
	--releases-file "$work/resume-releases" --runs-file "$work/runs" \
	--release-index "$work/resume-index.json" --receipt "$work/resume.json" >/dev/null \
	|| test "$?" -eq 1
jq -e '
	.entries[0].disposition == "resume"
	and .entries[0].certified_run_id == "12345"
	and (.entries[0].resume_command | contains("candidate_run_id=12345"))
	and .resolution == "complete"
' "$work/resume.json" >/dev/null
jq -e '.status == "complete" and .entries[0].disposition == "resume"' "$work/resume-index.json" >/dev/null

# Without a successor or certified run, the checker stays red and names the
# unresolved tag instead of silently treating a missing release as complete.
printf '%s\n' v0.2.65 > "$work/unresolved-tags"
if sh "$ROOT/scripts/tag-sweep.sh" --repo example/kit --tags-file "$work/unresolved-tags" \
	--releases-file "$work/resume-releases" --receipt "$work/unresolved.json" >/dev/null; then
	echo 'expected unresolved gap to fail closed' >&2
	exit 1
fi
jq -e '
	.status == "detected" and .resolution == "attention"
	and .unresolved_count == 1 and .unresolved[0].tag == "v0.2.65"
' "$work/unresolved.json" >/dev/null
printf '%s\n' 'ok tag sweep detects missing, stays quiet for published releases, and records resume/unresolved controls'

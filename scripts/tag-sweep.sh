#!/bin/sh
# TAGSWEEP1: detect vX.Y.Z tags without a published release and emit recovery evidence.
set -eu

repo=""
receipt="tag-sweep-receipt.json"
release_index=""
tags_file=""
releases_file=""
runs_file=""

usage() {
	echo "usage: tag-sweep.sh --repo OWNER/REPO [--receipt PATH] [--release-index PATH] [--tags-file PATH] [--releases-file PATH] [--runs-file PATH]" >&2
	exit 2
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--repo)
			[ "$#" -ge 2 ] || usage
			repo=$2
			shift 2
			;;
		--receipt)
			[ "$#" -ge 2 ] || usage
			receipt=$2
			shift 2
			;;
		--release-index)
			[ "$#" -ge 2 ] || usage
			release_index=$2
			shift 2
			;;
		--tags-file)
			[ "$#" -ge 2 ] || usage
			tags_file=$2
			shift 2
			;;
		--releases-file)
			[ "$#" -ge 2 ] || usage
			releases_file=$2
			shift 2
			;;
		--runs-file)
			[ "$#" -ge 2 ] || usage
			runs_file=$2
			shift 2
			;;
		*)
			usage
			;;
	esac
done

[ -n "$repo" ] || usage
case "$repo" in
	*/*) ;;
	*)
		echo "tag-sweep: --repo must be OWNER/REPO" >&2
		exit 2
		;;
esac
command -v jq >/dev/null 2>&1 || {
	echo "tag-sweep: jq is required" >&2
	exit 3
}

if [ -n "$tags_file" ]; then
	tags=$(awk '{
		tag = $1
		if (NF >= 2) tag = $2
		gsub(/\r/, "", tag)
		sub(/^refs\/tags\//, "", tag)
		sub(/\^\{\}$/, "", tag)
		if (tag != "") print tag
	}' "$tags_file" | sort -u)
else
	tags=$(git ls-remote --tags "https://github.com/$repo.git" 'refs/tags/v*' |
		awk '{
			tag = $2
			sub(/^refs\/tags\//, "", tag)
			sub(/\^\{\}$/, "", tag)
			if (tag != "") print tag
		}' | sort -u)
fi
tags_json=$(printf '%s\n' "$tags" | jq -Rsc 'split("\n") | map(select(length > 0)) | unique')

if [ -n "$releases_file" ]; then
	releases=$(cat "$releases_file")
else
	if ! releases=$(gh api --paginate --slurp "repos/$repo/releases?per_page=100"); then
		echo "tag-sweep: release lookup failed" >&2
		exit 3
	fi
fi
if ! releases_json=$(printf '%s' "$releases" | jq -ce '
	if type == "array" and (length == 0 or all(.[]; type == "array")) then
		if length == 0 then [] else add end
	elif type == "object" and (.releases? | type == "array") then
		.releases
	else
		.
	end
	| if type == "array" and all(.[]; type == "object") then . else error("release response must be an array of objects") end
'); then
	echo "tag-sweep: invalid release response" >&2
	exit 3
fi

# Fixture mode deliberately avoids a network lookup. Live runs query the completed
# release workflow so a gap can be resumed from its exact successful qualification.
if [ -n "$runs_file" ]; then
	runs=$(cat "$runs_file")
elif [ -n "$tags_file" ] || [ -n "$releases_file" ]; then
	runs="[]"
else
	if ! runs=$(gh api --paginate --slurp "repos/$repo/actions/workflows/release.yml/runs?status=completed&per_page=100"); then
		echo "tag-sweep: certified-run lookup failed" >&2
		exit 3
	fi
fi
if ! runs_json=$(printf '%s' "$runs" | jq -ce '
	if type == "array" and (length == 0 or all(.[]; type == "array")) then
		if length == 0 then [] else add end
	elif type == "array" and all(.[]; type == "object" and (.workflow_runs? | type == "array")) then
		[.[].workflow_runs[]]
	elif type == "object" and (.workflow_runs? | type == "array") then
		.workflow_runs
	else
		.
	end
	| if type == "array" and all(.[]; type == "object") then . else error("run response must be an array of objects") end
'); then
	echo "tag-sweep: invalid certified-run response" >&2
	exit 3
fi

generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# shellcheck source=scripts/kitlib-tmp.sh
. "$(dirname -- "$0")/kitlib-tmp.sh"
data_dir='' # assigned by kitlib_tmp via eval
kitlib_tmp data_dir tag-sweep-data
printf '%s\n' "$tags_json" > "$data_dir/tags.json"
printf '%s\n' "$releases_json" > "$data_dir/releases.json"
printf '%s\n' "$runs_json" > "$data_dir/runs.json"
if ! report=$(jq -n \
	--arg repo "$repo" \
	--arg generated_at "$generated_at" \
	--slurpfile tags "$data_dir/tags.json" \
	--slurpfile releases "$data_dir/releases.json" \
	--slurpfile runs "$data_dir/runs.json" '
	def semver($tag): ($tag | sub("^v"; "") | split(".") | map(tonumber));
	def valid_tag: test("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
	def stable_release:
		. as $release
		| ($release.tag_name? // null) as $tag
		| if ($tag | type) != "string" then false
			elif ($tag | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) | not then false
			else (($release.draft // false) != true and ($release.prerelease // false) != true)
			end;
	def certified($tag):
		([
			$runs[0][]?
			| select(type == "object")
			| select(.status == "completed" and .conclusion == "success")
			| select((.display_title // "") | startswith("qualify " + ($tag | sub("^v"; "") ) + " "))
			| select((.path // ".github/workflows/release.yml") == ".github/workflows/release.yml")
			| select((.head_branch // "main") == "main")
			| select((.id | type == "number") or ((.id | type == "string") and (.id | test("^[0-9]+$"))))
			| {
				id: (.id | tostring),
				title: (.display_title // ""),
				source_sha: (.head_sha // null)
			}
		] | sort_by(.id | tonumber) | .[-1]) // null;
	def successor($tag; $published):
		([
			$published[]
			| select(semver(.) > semver($tag))
		] | sort_by(semver(.)) | .[0]) // null;

	($releases[0] | map(select(stable_release) | .tag_name) | unique) as $published
	| ($tags[0] | map(. as $tag | select($tag | valid_tag) | select(($published | index($tag)) == null))) as $missing
	| ($missing | map(
		. as $tag
		| (successor($tag; $published)) as $replacement
		| if $replacement != null then
			{
				tag: $tag,
				disposition: "superseded",
				superseded_by: $replacement,
				certified_run_id: null,
				reason: "a newer published release resolves this older tag"
			}
		  else
			(certified($tag)) as $run
			| if $run != null then
				{
					tag: $tag,
					disposition: "resume",
					superseded_by: null,
					certified_run_id: $run.id,
					certified_run_title: $run.title,
					source_sha: $run.source_sha,
					resume_command: ("gh workflow run release-train.yml --repo " + $repo + " --ref main -f candidate_run_id=" + $run.id),
					reason: "successful exact-version qualification is available for recovery"
				}
			  else
				{
					tag: $tag,
					disposition: "unresolved",
					superseded_by: null,
					certified_run_id: null,
					reason: "no published successor or successful exact-version qualification was found"
				}
			  end
		  end
	)) as $entries
	| {
		schema_version: 1,
		kind: "tag-release-gap-sweep",
		repo: $repo,
		generated_at: $generated_at,
		last_release: (if ($published | length) == 0 then null else ($published | max_by(semver(.))) end),
		tags: $tags[0],
		published_tags: $published,
		missing: $missing,
		missing_count: ($missing | length),
		entries: $entries,
		resume: [$entries[] | select(.disposition == "resume")],
		superseded: [$entries[] | select(.disposition == "superseded")],
		unresolved: [$entries[] | select(.disposition == "unresolved")],
		resume_count: ([$entries[] | select(.disposition == "resume")] | length),
		superseded_count: ([$entries[] | select(.disposition == "superseded")] | length),
		unresolved_count: ([$entries[] | select(.disposition == "unresolved")] | length),
		status: (if ($missing | length) == 0 then "quiet" else "detected" end),
		resolution: (if ([$entries[] | select(.disposition == "unresolved")] | length) == 0 then "complete" else "attention" end)
	}
'); then
	echo "tag-sweep: failed to build sweep report" >&2
	exit 3
fi

mkdir -p "$(dirname "$receipt")"
receipt_tmp="${receipt}.tmp.$$"
printf '%s\n' "$report" > "$receipt_tmp"
mv "$receipt_tmp" "$receipt"

if [ -n "$release_index" ]; then
	mkdir -p "$(dirname "$release_index")"
	index_tmp="${release_index}.tmp.$$"
	printf '%s\n' "$report" | jq '{
		schema_version: 1,
		kind: "tag-release-gap-index",
		repo,
		generated_at,
		last_release,
		entries,
		status: .resolution
	}' > "$index_tmp"
	mv "$index_tmp" "$release_index"
fi

count=$(printf '%s\n' "$report" | jq -r '.missing_count')
resume_count=$(printf '%s\n' "$report" | jq -r '.resume_count')
superseded_count=$(printf '%s\n' "$report" | jq -r '.superseded_count')
unresolved_count=$(printf '%s\n' "$report" | jq -r '.unresolved_count')
status=$(printf '%s\n' "$report" | jq -r '.status')
last_release=$(printf '%s\n' "$report" | jq -r '.last_release // "none"')
printf 'TAG_SWEEP status=%s missing=%s resume=%s superseded=%s unresolved=%s last_release=%s receipt=%s\n' \
	"$status" "$count" "$resume_count" "$superseded_count" "$unresolved_count" "$last_release" "$receipt"
[ "$count" -eq 0 ]

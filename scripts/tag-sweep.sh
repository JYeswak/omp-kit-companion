#!/bin/sh
# TAGSWEEP1: detect vX.Y.Z tags with no GitHub release and emit a durable receipt.
set -eu
repo=""; receipt="tag-sweep-receipt.json"; tags_file=""; releases_file=""
usage() { echo "usage: tag-sweep.sh --repo OWNER/REPO [--receipt PATH] [--tags-file PATH] [--releases-file PATH]" >&2; exit 2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo=${2:-}; shift 2;;
    --receipt) receipt=${2:-}; shift 2;;
    --tags-file) tags_file=${2:-}; shift 2;;
    --releases-file) releases_file=${2:-}; shift 2;;
    *) usage;;
  esac
done
[ -n "$repo" ] || usage
command -v jq >/dev/null 2>&1 || { echo "tag-sweep: jq is required" >&2; exit 3; }
if [ -n "$tags_file" ]; then tags=$(cat "$tags_file"); else tags=$(git ls-remote --tags "https://github.com/$repo.git" 'refs/tags/v*' | awk -F/ '{print $3}' | sed 's/\\^{}$//' | sort -u); fi
if [ -n "$releases_file" ]; then releases=$(cat "$releases_file"); else releases=$(gh api --paginate "repos/$repo/releases?per_page=100" 2>/dev/null || { echo "tag-sweep: release lookup failed" >&2; exit 3; }); fi
missing=$(printf '%s\n' "$tags" | awk '/^v[0-9]+\.[0-9]+\.[0-9]+$/ {print}' | jq -Rsc --argjson releases "$releases" '[split("\n")[] | select(length > 0) as $tag | select(($releases | any(.tag_name == $tag)) | not)]')
count=$(printf '%s' "$missing" | jq 'length')
mkdir -p "$(dirname "$receipt")"
jq -n --arg repo "$repo" --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson tags "$(printf '%s\n' "$tags" | jq -Rsc 'split("\n") | map(select(length > 0))')" --argjson missing "$missing" '{schema_version:1,repo:$repo,generated_at:$generated_at,tags:$tags,missing:$missing,missing_count:($missing|length),status:(if ($missing|length)==0 then "quiet" else "detected" end)}' > "$receipt"
printf 'TAG_SWEEP status=%s missing=%s receipt=%s\n' "$( [ "$count" -eq 0 ] && echo quiet || echo detected )" "$count" "$receipt"
[ "$count" -eq 0 ]

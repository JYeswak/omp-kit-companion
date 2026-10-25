#!/bin/sh
# Install the archive-based fresh gate into the existing Agent Mail pre-push chain.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
HOOKS=$(git -C "$ROOT" rev-parse --git-path hooks)
CHAIN="$HOOKS/pre-push"
DEST="$HOOKS/hooks.d/pre-push/40-omp-kit-fresh-gate"
[ -x "$CHAIN" ] || { echo "install-pre-push-gate: expected executable chain runner: $CHAIN" >&2; exit 2; }
if ! grep -q 'hooks.d' "$CHAIN" || ! grep -q 'pre-push' "$CHAIN"; then
	echo "install-pre-push-gate: refusing to bypass an existing non-chain pre-push hook" >&2
	exit 2
fi
# Custody is enforced when work is edited/committed: Agent Mail's pre-commit plugin checks every staged path against
# other agents' exclusive leases. Publication judges the immutable shared-main snapshot, even while another agent
# edits those paths, so Agent Mail's pre-push plugin is not installed (SNAPSHOTPUB1 ompkit-v66l.14, Joshua
# J-2026-10-25-12): it re-judged committed history against later leases and vetoed releases. Jeff Emanuel's own
# repos install no hooks; upstream am supports pre-commit-only (`--no-prepush`). Publication races are handled by
# Git's fast-forward compare-and-swap on the ref (git_converge), and history admission by 30-omp-kit-on-main.
# Regenerate Agent Mail through its canonical installer: updating am alone leaves the previous decision installed.
# Preserve the refusal above before asking am to touch any existing hook.
command -v am >/dev/null 2>&1 || {
	echo "install-pre-push-gate: native am is required to regenerate reservation guards" >&2
	exit 2
}
# Native regeneration also touches pre-commit. Never displace somebody else's
# hook (even into a backup) while refreshing this publication member.
for hook in pre-commit pre-push; do
	path="$HOOKS/$hook"
	if [ -e "$path" ] && ! grep -Fq "mcp-agent-mail chain-runner ($hook)" "$path"; then
		echo "install-pre-push-gate: refusing to replace an existing non-chain $hook hook" >&2
		exit 2
	fi
done
# am 0.3.39's `install --no-prepush` keeps a pre-push plugin an earlier --prepush install left, so remove our
# plugins through its own uninstaller first (the chain runners stay while other members use them), then reinstall.
am guard uninstall "$ROOT"
am guard install "$ROOT" "$ROOT" --no-prepush
[ -f "$HOOKS/hooks.d/pre-commit/50-agent-mail.py" ] || {
	echo "install-pre-push-gate: Agent Mail pre-commit custody plugin missing after install" >&2
	exit 2
}
[ ! -e "$HOOKS/hooks.d/pre-push/50-agent-mail.py" ] || {
	echo "install-pre-push-gate: Agent Mail pre-push plugin still installed; publication would judge live leases" >&2
	exit 2
}
mkdir -p "$(dirname "$DEST")"
cp "$ROOT/scripts/pre-push-gate.sh" "$DEST"
chmod +x "$DEST"
printf 'installed pre-push fresh gate: %s\n' "$DEST"

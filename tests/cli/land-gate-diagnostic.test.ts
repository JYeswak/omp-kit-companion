import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { command, fixture, git, LAND_DEFAULT_TIMEOUT_MS, remoteHead, responseCode } from "./private-index-land.helpers.ts";

test("LANDDIAG1 exact-parent reports the failed gate rather than its trailing metrics", () => {
	for (const [phase, reason] of [
		["staged", "staged-members: REFUSED: check-staged-kitlib.sh"],
		["focused", "focused shellcheck: findings refuse the push"],
	] as const) {
		const { work, fakeBin } = fixture();
		mkdirSync(join(work, "scripts"), { recursive: true });
		writeFileSync(join(work, "scripts", "fresh-gate.sh"), [
			"#!/bin/sh",
			`printf '%s\\n' '${reason}'`,
			`printf 'RED ${phase} producer_rc=1\\n' >&2`,
			`printf 'FRESH-GATE: measured-verdict {"rc":1}\\n'`,
			"exit 1",
			"",
		].join("\n"));
		git(work, ["add", "--", "scripts/fresh-gate.sh"]);
		git(work, ["commit", "-m", "fixture: retain exact parent's gate [test]"]);
		git(work, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
		const base = remoteHead(work);
		writeFileSync(join(work, "reviewed.txt"), "reviewed candidate bytes\n");
		git(work, ["add", "--", "reviewed.txt"]);
		git(work, ["commit", "-m", "fixture: reviewed exact-parent candidate [test]"]);
		const candidate = git(work, ["rev-parse", "HEAD"]).trim();
		const holds = [{ agent: "DarkFern", path: "reviewed.txt", exclusive: true, remaining_seconds: 3600 }];
		const refused = command(work, ["--exact-parent", candidate, "--apply", "--yes"], holds, { amDir: fakeBin });
		expect(refused.status).not.toBe(0);
		expect(responseCode(refused.body)).toBe("LAND_PUBLICATION_REFUSED");
		expect(JSON.stringify(refused.body)).toContain(reason);
		expect(JSON.stringify(refused.body)).not.toContain("measured-verdict");
		expect(remoteHead(work)).toBe(base);
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(candidate);
	}
}, LAND_DEFAULT_TIMEOUT_MS);

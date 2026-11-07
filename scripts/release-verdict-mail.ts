#!/usr/bin/env bun
import { notifyReleaseVerdict } from "../src/release-verdict-mail.ts";

const [state, sha, producer] = process.argv.slice(2);
if (!state || !sha || !/^[0-9a-f]{40}$/.test(sha) || !producer || !/^[0-9]+$/.test(producer)) {
	console.error("release-verdict: invalid mail notification arguments");
	process.exitCode = 2;
} else {
	try { await notifyReleaseVerdict(state, sha, Number(producer)); }
	catch {
		console.error("release-verdict: mail wake failed (verdict unchanged)");
		process.exitCode = 1;
	}
}

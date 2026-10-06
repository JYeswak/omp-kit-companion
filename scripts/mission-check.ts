#!/usr/bin/env bun
import process from "node:process";

const args = Bun.argv.slice(2);
const checkCommands: Record<string, readonly string[]> = {
	current: ["omp-kit", "status", "--json"],
	loaded: ["omp-kit", "doctor", "--scope", "rules", "--json"],
	proven: ["bun", "scripts/regex-budget.ts"],
	measured: ["omp-kit", "doctor", "--scope", "load", "--json"],
	shareable: ["bun", "test", "tests/cli/docs.test.ts"],
};

if (args.length !== 2 || args[0] !== "--pillar" || !args[1]) {
	process.stderr.write("usage: bun scripts/mission-check.ts --pillar PILLAR_ID\n");
	process.exitCode = 2;
} else if (args[1] === "learning") {
	const result = Bun.spawnSync(["git", "log", "--since=7 days ago", "--format=", "--name-only", "--", "rules"], {
		cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		process.stderr.write(`mission learning check: git log failed (${result.exitCode ?? "signal"})\n`);
		process.exitCode = result.exitCode ?? 1;
	} else {
		const rules = [...new Set(result.stdout.toString("utf8").split("\n").map(path => path.trim())
			.filter(path => /^rules\/[a-z0-9][a-z0-9-]*\.(?:md|toml)$/.test(path) && /(?:uphill|lr1)/i.test(path)))].sort();
		process.stdout.write(`${JSON.stringify({ pillar: "learning", window_days: 7, uphill_or_lr1_rules_shipped: rules.length, rules })}\n`);
	}
} else {
	const command = checkCommands[args[1]];
	if (!command) {
		process.stderr.write(`unknown mission pillar: ${args[1]}\n`);
		process.exitCode = 2;
	} else {
		const result = Bun.spawnSync([...command], { cwd: process.cwd(), stdout: "inherit", stderr: "inherit" });
		process.exitCode = result.exitCode ?? 1;
	}
}

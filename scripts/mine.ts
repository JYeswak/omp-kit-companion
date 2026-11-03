#!/usr/bin/env bun
// Source-checkout entry for the same implementation wired into omp-kit mine.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runMine, renderMine } from "../src/mine.ts";

try {
	const { values } = parseArgs({ args: process.argv.slice(2), options: {
		since: { type: "string" }, until: { type: "string" }, project: { type: "string" },
		all: { type: "boolean" }, json: { type: "boolean" },
	}, strict: true, allowPositionals: false });
	const report = await runMine({ since: values.since ?? "", until: values.until ?? "", all: values.all,
		project: values.project, root: resolve(import.meta.dir, "..") });
	console.log(values.json ? JSON.stringify(report) : renderMine(report));
} catch (error) {
	console.error(error instanceof Error ? error.message : "mine failed");
	process.exitCode = 2;
}

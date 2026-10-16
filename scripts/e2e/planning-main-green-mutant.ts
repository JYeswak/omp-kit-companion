import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Test-only loader: mutate this CLI subprocess in memory, never the shared file.
const target = resolve(import.meta.dir, "../../src/planning-score.ts");
const mutations: Record<string, readonly [string, string]> = {
	"drop-head-filter": ["if (run.headSha !== branchHeadSha) continue;", ""],
	"earliest-run": ["time > latestTime", "time < latestTime"],
};
const mutation = mutations[process.env.MAINGREEN_MUTANT ?? ""];
if (!mutation) throw new Error("Unknown MAINGREEN_MUTANT");
plugin({
	name: "planning-main-green-mutation",
	setup(build) {
		build.onLoad({ filter: /planning-score[.]ts$/ }, ({ path }) => {
			if (path !== target) return;
			const contents = readFileSync(path, "utf8");
			if (!contents.includes(mutation[0]) || contents.indexOf(mutation[0]) !== contents.lastIndexOf(mutation[0]))
				throw new Error("Mutation anchor is missing or ambiguous");
			return { contents: contents.replace(mutation[0], mutation[1]), loader: "ts" };
		});
	},
});

import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Test-only compiler overlay; the canonical source and shared checkout never change.
const mutations: Record<string, { file: string; from: string; to: string }> = {
	"stale-convert-guard": {
		file: "planning-convert.ts",
		from: '!("acceptance_present_share" in value)',
		to: '!("test_share" in value)',
	},
	"old-output-key": {
		file: "planning-score.ts",
		from: "acceptance_present_share: acceptancePresentShare,",
		to: "acceptance_present_share: acceptancePresentShare, test_share: acceptancePresentShare,",
	},
};
const mutation = mutations[process.env.PLANNING_SHARE_MUTANT ?? ""];
if (!mutation) throw new Error("Unknown PLANNING_SHARE_MUTANT");
const target = resolve(import.meta.dir, "../../src", mutation.file);
plugin({
	name: "planning-share-name-mutation",
	setup(build) {
		build.onLoad({ filter: /planning-(score|convert)[.]ts$/ }, ({ path }) => {
			const contents = readFileSync(path, "utf8");
			if (path !== target) return { contents, loader: "ts" };
			if (!contents.includes(mutation.from) || contents.indexOf(mutation.from) !== contents.lastIndexOf(mutation.from))
				throw new Error("Mutation anchor is missing or ambiguous");
			return { contents: contents.replace(mutation.from, mutation.to), loader: "ts" };
		});
	},
});

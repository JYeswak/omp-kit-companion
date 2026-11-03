// Coverage: src/commands.ts, src/cli.ts, src/kitlib/tmp.ts, src/kitlib/run.ts, scripts/bead_lint.py
import { afterAll, expect } from "bun:test";
import { join } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp.ts";
import { planningFixture } from "./planning-convert.helpers.ts";
afterAll(cleanupAllOwnedTmp);
const { scratch, isolatedTest, runCli, nativeOutput, nativeJson, writePlan, initializeTracker, createNativeIssue, showNativeIssue, applyResult, applyArgs, nativeShapeFixture } = planningFixture();
for (const nullableText of [false, true]) {
	isolatedTest(`planning convert applies with native sparse optional fields (${nullableText ? "null text" : "omitted"})`, async () => {
		const trackerRoot = join(scratch, "apply-sparse-" + nullableText);
		initializeTracker(trackerRoot);
		createNativeIssue(trackerRoot, "Core8 epic", { externalRef: "core8", type: "epic" });
		const sparse = nativeJson(["create", "--title", "Sparse native target", "--type", "task", "--priority", "1"], trackerRoot);
		if (typeof sparse !== "object" || sparse === null || !("id" in sparse) || typeof sparse.id !== "string") {
			throw new Error("native sparse create returned no id");
		}
		const before = showNativeIssue(trackerRoot, sparse.id);
		expect(before.description ?? "").toBe("");
		expect(before.acceptance_criteria ?? "").toBe("");
		expect(before.labels ?? []).toEqual([]);
		const plan = writePlan("sparse-" + nullableText, [
			{ slug: "new-sparse-neighbor", existing: "(new)" },
			{ slug: "amend-sparse-target", existing: sparse.id + " (amend)" },
		]);
		const result = await runCli(applyArgs(plan, trackerRoot),
			nullableText ? nativeShapeFixture(trackerRoot, sparse.id, "both:description:null-text") : {});
		expect(result.exitCode).toBe(0);
		expect(applyResult(result).overall).toBe("CLEAN");
		const after = showNativeIssue(trackerRoot, sparse.id);
		expect(after.title).toBe("Sparse native target");
		expect(after.description ?? "").toBe("");
		expect(after.acceptance_criteria).toContain("amend-sparse-target contributes its positive acceptance criterion");
		expect(applyResult(result).created_items).toMatchObject([{ slug: "new-sparse-neighbor" }]);
	});
}

for (const mode of [
	"list:description:number", "list:acceptance_criteria:number", "list:labels:null", "list:labels:element",
	"list:id:missing", "list:title:missing", "list:status:missing", "list:priority:string",
	"list:priority:missing",
	"list:issue_type:missing", "list:dependency_count:missing",
	"show:description:number", "show:labels:string", "show:id:identity", "show:updated_at:missing",
]) {
	isolatedTest(`planning convert refuses malformed present native fields before writes (${mode})`, async () => {
		const trackerRoot = join(scratch, "bad-native-" + mode.replaceAll(":", "-"));
		initializeTracker(trackerRoot);
		createNativeIssue(trackerRoot, "Core8 epic", { externalRef: "core8", type: "epic" });
		const target = createNativeIssue(trackerRoot, "Existing target");
		const plan = writePlan("bad-native-" + mode.replaceAll(":", "-"), [
			{ slug: "new-after-preflight", existing: "(new)" },
			{ slug: "amend-after-preflight", existing: target + " (amend)" },
		]);
		const before = nativeOutput(["list", "--all", "--limit", "0"], trackerRoot);
		const result = await runCli(applyArgs(plan, trackerRoot), nativeShapeFixture(trackerRoot, target, mode));
		expect(result.exitCode).not.toBe(0);
		expect(applyResult(result).overall).toBe("REFUSED");
		expect(nativeOutput(["list", "--all", "--limit", "0"], trackerRoot)).toBe(before);
	});
}


import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every setup-bun step in the CI and OMP-certification workflows installs the Bun pinned in .bun-version.
// An unpinned setup-bun installs whatever Bun is latest at run time, so a Bun release could change CI behavior
// between two runs of the same commit (ntm's release failed 8 of 8 runs on such a toolchain mismatch).
const REPO_ROOT = join(import.meta.dir, "..", "..");
const PINNED_WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/omp-certify.yml"];
type Step = { uses?: string; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const isSetupBun = (step: Step) => String(step.uses ?? "").startsWith("oven-sh/setup-bun@");

function unpinnedSteps(workflow: Workflow): string[] {
	const found: string[] = [];
	for (const [name, job] of Object.entries(workflow.jobs)) {
		(job.steps ?? []).forEach((step, index) => {
			if (!isSetupBun(step)) return;
			const inputs = step.with ?? {};
			if (inputs["bun-version-file"] !== ".bun-version" || "bun-version" in inputs) found.push(`${name} step ${index}`);
		});
	}
	return found;
}

// Exact MAJOR.MINOR.PATCH: a range, tag or prerelease would let setup-bun resolve a different Bun later.
function isExactVersion(text: string): boolean {
	const parts = text.split(".");
	return parts.length === 3 && parts.every(part => part.length > 0 && [...part].every(char => char >= "0" && char <= "9"));
}

test(".bun-version names one exact Bun version", () => {
	const text = readFileSync(join(REPO_ROOT, ".bun-version"), "utf8");
	expect(text.endsWith("\n") && text.split("\n").length === 2).toBe(true);
	expect(isExactVersion(text.trim())).toBe(true);
	for (const loose of ["latest", "1.4.x", "1.4", "v1.4.3", "1.4.3-canary", "1..3"]) expect(isExactVersion(loose)).toBe(false);
});

test("every setup-bun step in the CI and OMP-certification workflows reads .bun-version", () => {
	for (const relative of PINNED_WORKFLOWS) {
		const workflow = Bun.YAML.parse(readFileSync(join(REPO_ROOT, relative), "utf8")) as Workflow;
		expect(Object.values(workflow.jobs).flatMap(job => job.steps ?? []).filter(isSetupBun).length).toBeGreaterThan(0);
		expect({ relative, unpinned: unpinnedSteps(workflow) }).toEqual({ relative, unpinned: [] });
	}
});

test("a planted unpinned, latest or inline-pinned setup-bun step is found", () => {
	const source = readFileSync(join(REPO_ROOT, PINNED_WORKFLOWS[0]!), "utf8");
	for (const plant of [undefined, { "bun-version": "latest" }, { "bun-version-file": ".bun-version", "bun-version": "1.4.3" }]) {
		const planted = Bun.YAML.parse(source) as Workflow;
		const step = planted.jobs["stock-extensions"]!.steps!.find(isSetupBun)!;
		step.with = plant;
		expect(unpinnedSteps(planted)).toEqual(["stock-extensions step 1"]);
	}
});

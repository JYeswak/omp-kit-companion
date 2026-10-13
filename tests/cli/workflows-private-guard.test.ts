import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const workflowsDir = join(import.meta.dir, "../../.github/workflows");
const GUARD = "github.event.repository.private == false";

const files = readdirSync(workflowsDir).filter(file => file.endsWith(".yml") || file.endsWith(".yaml"));
for (const file of files) {
	test(`${file}: every job carries the private-repo billing guard`, () => {
		const parsed = Bun.YAML.parse(readFileSync(join(workflowsDir, file), "utf8")) as { jobs?: Record<string, Record<string, unknown>> };
		const jobs = parsed?.jobs ?? {};
		expect(Object.keys(jobs).length).toBeGreaterThan(0);
		for (const [name, job] of Object.entries(jobs)) {
			const condition = job.if;
			expect(typeof condition === "string" && condition.includes(GUARD)).toBe(true);
		}
	});
}
const nativeCiJobs = ["build-candidates", "real-home-journey", "native-certification"] as const;
const ciPath = join(workflowsDir, "ci.yml");
type CiWorkflow = {
	on?: { schedule?: { cron?: string }[] };
	jobs?: Record<string, { if?: unknown }>;
};

function ciJobRunsForEvent(condition: unknown, eventName: string): boolean {
	expect(typeof condition).toBe("string");
	if (typeof condition !== "string") return false;

	return condition.split("&&").map(term => term.trim()).every(term => {
		if (term === "github.event.repository.private == false") return true;
		const prefix = "github.event_name != '";
		if (term.startsWith(prefix) && term.endsWith("'")) {
			return eventName !== term.slice(prefix.length, -1);
		}
		throw new Error(`unsupported CI job condition: ${term}`);
	});
}

test("ci.yml skips expensive native jobs on pushes but keeps workflow_call and daily runs", () => {
	const workflow = Bun.YAML.parse(readFileSync(ciPath, "utf8")) as CiWorkflow;
	const jobs = workflow.jobs ?? {};
	const events = ["push", "workflow_call", "schedule"] as const;
	for (const name of nativeCiJobs) {
		const condition = jobs[name]?.if;
		expect(typeof condition).toBe("string");
		for (const eventName of events) {
			expect(ciJobRunsForEvent(condition, eventName)).toBe(eventName !== "push");
		}
	}
	expect(workflow.on?.schedule?.map(trigger => trigger.cron)).toContain("17 9 * * *");
});

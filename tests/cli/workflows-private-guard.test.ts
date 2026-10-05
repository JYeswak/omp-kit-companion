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

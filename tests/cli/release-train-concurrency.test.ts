import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

/** v66l.3: a workflow-level concurrency group lets skipped train runs cancel a pending publish. */
const WORKFLOW = process.env.RELEASE_TRAIN_PATH ?? join(import.meta.dir, "../../.github/workflows/release-train.yml");
function concurrencyOf(text: string): { top: unknown; train: unknown; publish: unknown } {
	const doc = YAML.parse(text) as { concurrency?: unknown; jobs?: Record<string, { concurrency?: unknown }> };
	const group = (node: unknown): unknown =>
		typeof node === "string" ? node : node !== null && typeof node === "object" ? (node as Record<string, unknown>).group ?? null : null;
	return { top: group(doc.concurrency), train: group(doc.jobs?.train?.concurrency), publish: group(doc.jobs?.publish?.concurrency) };
}

test("publish does not share a workflow-level concurrency group with skipped runs", () => {
	const shape = concurrencyOf(readFileSync(WORKFLOW, "utf8"));
	expect(shape.publish).toBe("release-train-publish");
	expect(shape.top).toBeNull();
});

test("planted: restored workflow-level concurrency fails the structure check", () => {
	const fixture = ["name: x", "concurrency:", "  group: release-train", "jobs:", "  publish:", "    runs-on: ubuntu-latest"].join("\n") + "\n";
	expect(concurrencyOf(fixture).top).toBe("release-train");
});

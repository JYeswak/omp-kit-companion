import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

test("bun test preload creates repo scratch root before fixtures", () => {
	expect(existsSync(resolve(import.meta.dir, "../../var/agent-tmp"))).toBe(true);
});

import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyMigration, planMigration, planMigrationMutation } from "../../src/migrate.ts";

const root = resolve(import.meta.dir, "../..");

test("released historical rule copies remove with backup while one-byte edits overlay", () => {
	const fixture = mkdtempSync(join(resolve(root, "var/agent-tmp"), "migrate-history-"));
	try {
		const home = join(fixture, "home");
		const legacyDir = join(home, ".agents", "rules");
			const pluginDir = join(fixture, "plugin", "rules");
			const sourceDir = join(fixture, "source");
			const sourceRulesDir = join(sourceDir, "rules");
			const stateRoot = join(home, ".local", "state", "omp-kit");
			mkdirSync(legacyDir, { recursive: true });
			mkdirSync(pluginDir, { recursive: true });
			mkdirSync(sourceRulesDir, { recursive: true });
			const pluginPath = join(pluginDir, "kit-test-skip.md");
			const current = readFileSync(join(root, "rules", "kit-test-skip.md"));
			writeFileSync(pluginPath, current);
			writeFileSync(join(sourceRulesDir, "kit-test-skip.md"), current);
			const currentSha256 = createHash("sha256").update(current).digest("hex");
			writeFileSync(join(sourceDir, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nkit-test-skip\t${currentSha256}\ttripwire\tabcdef1\n`);
			writeFileSync(join(sourceRulesDir, "released-sha256.json"), readFileSync(join(root, "rules", "released-sha256.json")));
			const legacyPath = join(legacyDir, "kit-test-skip.md");
			const historical = readFileSync(join(root, "tests", "fixtures", "migrate", "v0.1.0-kit-test-skip.md"));
			writeFileSync(legacyPath, historical);
		const run = () => ({
			code: 0,
			stdout: JSON.stringify({ rules: [{ name: "kit-test-skip", path: pluginPath, provider: "omp-plugins" }] }),
			stderr: "",
		});
		const input = { root: sourceDir, home, stateRoot, ompLauncher: "omp", run };
		const stale = planMigration(input);
		const staleRow = stale.rows.find(row => row.name === "kit-test-skip");
		expect(staleRow?.verdict).toBe("stale-kit-version");
		expect(staleRow?.overlay).toBe(false);
		planMigrationMutation(stale, input);
		const applied = applyMigration(stale, input, { confirmed: true });
		expect(applied.removed).toEqual(["kit-test-skip"]);
		expect(readFileSync(join(applied.backupDir, "kit-test-skip.md"))).toEqual(historical);
		writeFileSync(legacyPath, Buffer.concat([historical, Buffer.from("x")]));
		const edited = planMigration(input);
		const editedRow = edited.rows.find(row => row.name === "kit-test-skip");
		expect(editedRow?.verdict).toBe("edited");
		expect(editedRow?.overlay).toBe(true);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

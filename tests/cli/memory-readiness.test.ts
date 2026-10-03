import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectMemoryReadiness } from "../../src/memory-readiness.ts";

const fixtures: string[] = [];
const INSTALLED_OMP_PATH = process.env.OMP_MEMORY_SOURCE_PATH ?? process.env.OMP_INSTALLED_PATH ?? Bun.which("omp");
if (!INSTALLED_OMP_PATH) throw new Error("memory-readiness tests require an installed OMP on PATH");
const INSTALLED_OMP_ROOT = dirname(dirname(realpathSync(INSTALLED_OMP_PATH)));
const INSTALLED_OMP_VERSION = JSON.parse(readFileSync(join(INSTALLED_OMP_ROOT, "package.json"), "utf8")).version as string;
const OMP_SOURCE_FILES = [
	"src/memory-backend/redact.ts",
	"src/memory-backend/settings.ts",
	"src/memory-backend/resolve.ts",
	"src/config/settings.ts",
] as const;
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(version: string = INSTALLED_OMP_VERSION) {
	const root = mkdtempSync(join(tmpdir(), "omp-kit-memory-"));
	fixtures.push(root);
	const home = join(root, "home"), project = join(root, "project"), agent = join(home, ".omp", "agent");
	const pkg = join(root, "omp");
	mkdirSync(agent, { recursive: true }); mkdirSync(project); mkdirSync(join(pkg, "dist"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }));
	const ompPath = join(pkg, "dist", "cli.js"); writeFileSync(ompPath, "#!/bin/sh\nexit 91\n");
	for (const relativePath of OMP_SOURCE_FILES) {
		const target = join(pkg, relativePath);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, readFileSync(join(INSTALLED_OMP_ROOT, relativePath)));
	}
	const config = join(agent, "config.yml");
	const inspect = (installedPath = ompPath) => inspectMemoryReadiness({ home, project, ompPath: installedPath });
	return { root, home, project, agent, config, ompPath, ompRoot: pkg, inspect };
}
function snapshot(dir: string, prefix = ""): string[] {
	return readdirSync(dir).sort().flatMap(name => {
		const path = join(dir, name), rel = join(prefix, name), stat = lstatSync(path);
		if (stat.isDirectory()) return [`${rel}:dir:${stat.mode & 0o777}`, ...snapshot(path, rel)];
		if (stat.isSymbolicLink()) return [`${rel}:link:${readFileSync(path).toString("hex")}`];
		return [`${rel}:file:${stat.mode & 0o777}:${readFileSync(path).toString("hex")}`];
	});
}

test(`reviewed OMP [1m${INSTALLED_OMP_VERSION}[0m source hashes report on-disk OFF and the redactor limitation`, async () => {
	const f = fixture(INSTALLED_OMP_VERSION);
	writeFileSync(f.config, "memory:\n  backend: off\n");
	const report = await f.inspect();
	expect(report.backend).toBe("off");
	expect(report.configured).toBe(false);
	expect(report.runtime).toBe("NOT_PROBED");
	expect(report.redactor).toMatchObject({ status: "MISSES", version: INSTALLED_OMP_VERSION, coverage: "SYNTHETIC_ONLY" });
	expect(report.redactor.missed).toContain("pem_private_key");
});

test("reviewed source hashes, not package version, govern memory inspection", async () => {
	const f = fixture("99.0.0");
	writeFileSync(f.config, "memory:\n  backend: off\n");
	const report = await f.inspect();
	expect(report.backend).toBe("off");
	expect(report.redactor.status).toBe("MISSES");
	expect(report.redactor.version).toBe("99.0.0");
});

test("one changed redactor source byte refuses the synthetic probe", async () => {
	const f = fixture(INSTALLED_OMP_VERSION);
	const accepted = await f.inspect();
	expect(accepted.redactor).toMatchObject({ status: "MISSES", version: INSTALLED_OMP_VERSION, coverage: "SYNTHETIC_ONLY" });
	const relativePath = "src/memory-backend/redact.ts";
	const path = join(f.ompRoot, relativePath);
	const bytes = Buffer.from(readFileSync(path));
	bytes[0] = (bytes[0] ?? 0) ^ 1;
	writeFileSync(path, bytes);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const report = await f.inspect();
	expect(report.redactor).toMatchObject({ status: "UNVERIFIED", version: INSTALLED_OMP_VERSION, coverage: "NOT_PROBED", missed: [] });
	expect(report.redactor.reason).toContain(`${relativePath} sha256=${sha256}`);
});

test("one changed memory settings source byte names the exact path and hash", async () => {
	for (const source of OMP_SOURCE_FILES.filter(path => path !== "src/memory-backend/redact.ts")) {
		const f = fixture(INSTALLED_OMP_VERSION);
		writeFileSync(f.config, "memory:\n  backend: off\n");
		const accepted = await f.inspect();
		expect(accepted).toMatchObject({ backend: "off", configured: false, runtime: "NOT_PROBED" });
		const path = join(f.ompRoot, source);
		const bytes = Buffer.from(readFileSync(path));
		bytes[0] = (bytes[0] ?? 0) ^ 1;
		writeFileSync(path, bytes);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const report = await f.inspect();
		expect(report.backend).toBe("UNVERIFIED");
		expect(report.status).toBe("UNVERIFIED");
		expect(report.reason).toContain(`${source} sha256=${sha256}`);
	}
});

test("OFF and configured Mnemopi do not turn into runtime OK", async () => {
	const f = fixture();
	writeFileSync(f.config, "memory:\n  backend: off\n");
	const off = await f.inspect();
	expect(off.backend).toBe("off"); expect(off.status).toBe("DEGRADED"); expect(off.runtime).toBe("NOT_PROBED");
	writeFileSync(f.config, "memory:\n  backend: mnemopi\nmnemopi:\n  autoRetain: false\n  autoRecall: true\n  scoping: per-project-tagged\n  noEmbeddings: true\n  llmMode: none\n");
	const on = await f.inspect();
	expect(on.backend).toBe("mnemopi"); expect(on.configured).toBe(true);
	expect(on.auto_retain).toBe(false); expect(on.auto_recall).toBe(true);
	expect(on.scoping).toBe("per-project-tagged"); expect(on.embedding).toBe("DISABLED_FTS_ONLY");
	expect(on.store).toBe("NOT_CREATED"); expect(on.status).not.toBe("OK");
});

test("empty-not-created store and observed local SQLite store remain distinct without reading rows", async () => {
	const f = fixture();
	writeFileSync(f.config, "memory:\n  backend: mnemopi\nmnemopi:\n  noEmbeddings: true\n  llmMode: none\n");
	const absent = await f.inspect(); expect(absent.store).toBe("NOT_CREATED");
	const db = join(f.agent, "memories", "mnemopi", "mnemopi.db");
	mkdirSync(join(f.agent, "memories", "mnemopi"), { recursive: true });
	writeFileSync(db, Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(100)]));
	const before = snapshot(f.home);
	const observed = await f.inspect();
	expect(observed.store).toBe("OBSERVED_SCHEMA_UNVERIFIED");
	expect(observed.status).toBe("DEGRADED");
	expect(observed.redactor.missed).toContain("pem_private_key");
	expect(snapshot(f.home)).toEqual(before);
	writeFileSync(db, "not a SQLite database");
	expect((await f.inspect()).store).toBe("UNKNOWN_SCHEMA");
});

test("an explicit XDG state root is inspected without creating or reading its memory rows", async () => {
	const f = fixture();
	const xdg = join(f.root, "xdg-state"), store = join(xdg, "omp", "memories", "mnemopi");
	mkdirSync(store, { recursive: true });
	writeFileSync(join(store, "mnemopi.db"), Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(100)]));
	writeFileSync(f.config, "memory:\n  backend: mnemopi\nmnemopi:\n  noEmbeddings: true\n  llmMode: none\n");
	const before = snapshot(xdg);
	const report = await inspectMemoryReadiness({ home: f.home, project: f.project, ompPath: f.ompPath, xdgStateHome: xdg });
	expect(report.store).toBe("OBSERVED_SCHEMA_UNVERIFIED");
	expect(snapshot(xdg)).toEqual(before);
});

test("parked model role cannot count as model availability and remains separate from missing role", async () => {
	const f = fixture();
	writeFileSync(f.config, "memory:\n  backend: mnemopi\nmodelRoles:\n  memory: ollama/qwen3.8:27b-mlx\nmnemopi:\n  noEmbeddings: true\n");
	const parked = await f.inspect();
	expect(parked.model).toBe("UNVERIFIED_LOCAL");
	expect(parked.status).toBe("DEGRADED");
	expect(parked.redactor.missed).toContain("pem_private_key");
	expect(parked.recommended_action).toContain("local model");
	writeFileSync(f.config, "memory:\n  backend: mnemopi\nmodelRoles:\n  smol: ollama/qwen3.8:27b-mlx\nmnemopi:\n  noEmbeddings: true\n");
	expect((await f.inspect()).model).toBe("UNVERIFIED_LOCAL");
	writeFileSync(f.config, "memory:\n  backend: mnemopi\nmnemopi:\n  noEmbeddings: true\n");
	expect((await f.inspect()).model).toBe("UNRESOLVED_ROLE");
});

test("malformed, unsupported and unsafe profile layers refuse an effective backend claim", async () => {
	const f = fixture();
	writeFileSync(f.config, "memory: [oops\n");
	expect((await f.inspect()).backend).toBe("UNVERIFIED");
	writeFileSync(f.config, "memories:\n  enabled: true\n");
	expect((await f.inspect()).backend).toBe("UNVERIFIED");
	writeFileSync(f.config, "memory:\n  backend: mnemopi\n");
	writeFileSync(join(f.agent, "settings.json"), "{}");
	expect((await f.inspect()).backend).toBe("UNVERIFIED");
	rmSync(join(f.agent, "settings.json"));
	mkdirSync(join(f.project, ".omp")); writeFileSync(join(f.project, ".omp", "config.yml"), "memory:\n  backend: off\n");
	expect((await f.inspect()).backend).toBe("off");
	writeFileSync(join(f.project, ".omp", "config.yml"), "memory: [oops\n");
	expect((await f.inspect()).backend).toBe("UNVERIFIED");
});

test("custom store symlink and inaccessible store do not get dereferenced or certified", async () => {
	const f = fixture();
	const elsewhere = join(f.root, "secret.db"); writeFileSync(elsewhere, "do not read this secret");
	const db = join(f.agent, "db.sqlite"); symlinkSync(elsewhere, db);
	writeFileSync(f.config, `memory:\n  backend: mnemopi\nmnemopi:\n  dbPath: ${db}\n  llmMode: none\n  noEmbeddings: true\n`);
	const before = snapshot(f.home);
	const report = await f.inspect();
	expect(report.store).toBe("INACCESSIBLE");
	expect(JSON.stringify(report)).not.toContain(f.root);
	expect(JSON.stringify(report)).not.toContain("do not read this secret");
	expect(snapshot(f.home)).toEqual(before);
	rmSync(db); writeFileSync(db, "SQLite format 3\0"); chmodSync(db, 0o000);
	expect((await f.inspect()).store).toBe("INACCESSIBLE");
});

test("synthetic redactor canaries report source-pinned limits without exposing canary bytes", async () => {
	const f = fixture(INSTALLED_OMP_VERSION);
	writeFileSync(f.config, "memory:\n  backend: mnemopi\nmnemopi:\n  llmMode: none\n  noEmbeddings: true\n");
	const before = [snapshot(f.home), snapshot(f.project)];
	const report = await f.inspect(INSTALLED_OMP_PATH);
	expect(report.redactor).toMatchObject({ status: "MISSES", version: INSTALLED_OMP_VERSION, coverage: "SYNTHETIC_ONLY" });
	expect(report.redactor.missed).toContain("pem_private_key");
	expect(report.backend).toBe("mnemopi");
	expect(report.runtime).toBe("NOT_PROBED");
	expect(JSON.stringify(report)).not.toContain("PRIVATE KEY-----");
	expect(JSON.stringify(report)).not.toContain("syntheticbearerletters");
	expect([snapshot(f.home), snapshot(f.project)]).toEqual(before);
});

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { auditMemoryAtRest } from "../../src/memory-audit.ts";

// initBeam is imported only when its exact reviewed schema source bytes match.
// schema.ts SHA256: 95490e3c2b7e4325cde97fadf3572d76f11e28491e24574b27ff885171058ed0.
// Fixtures call the actual installed initBeam, not a hand-written imitation.
// Runtime-selected installation: a static import would bind the contributor's
// source tree instead of the supported OMP package under inspection.
const REVIEWED_SCHEMA_SHA256 = "95490e3c2b7e4325cde97fadf3572d76f11e28491e24574b27ff885171058ed0";
const AUDIT_SOURCE_FILES = [
	["agent", "src/mnemopi/config.ts"],
	["agent", "src/mnemopi/state.ts"],
	["mnemopi", "src/core/banks.ts"],
	["mnemopi", "src/core/beam/schema.ts"],
	["mnemopi", "src/db.ts"],
	["mnemopi", "src/core/episodic-graph.ts"],
	["mnemopi", "src/core/query-cache.ts"],
	["mnemopi", "src/core/shmr.ts"],
	["mnemopi", "src/core/veracity-consolidation.ts"],
	["mnemopi", "src/core/binary-vectors.ts"],
	["mnemopi", "src/core/cost-log.ts"],
] as const;
const installed = process.env.OMP_INSTALLED_PATH ?? Bun.which("omp") ?? "";
let initBeam: ((db: Database) => void) | undefined;
let installedVersion: string | undefined;
let installedAgentRoot: string | undefined;
let installedMnemopiRoot: string | undefined;
if (installed) {
	try {
		const agent = dirname(dirname(realpathSync(installed)));
		const mnemopi = join(dirname(agent), "pi-mnemopi");
		const metadata = JSON.parse(readFileSync(join(agent, "package.json"), "utf8"));
		const engine = JSON.parse(readFileSync(join(mnemopi, "package.json"), "utf8"));
		const schema = join(mnemopi, "src/core/beam/schema.ts");
		if (metadata.name === "@oh-my-pi/pi-coding-agent" && engine.name === "@oh-my-pi/pi-mnemopi" &&
			typeof metadata.version === "string" && metadata.version.length > 0 &&
			createHash("sha256").update(readFileSync(schema)).digest("hex") === REVIEWED_SCHEMA_SHA256) {
			({ initBeam } = await import(schema));
			installedVersion = metadata.version;
			installedAgentRoot = agent;
			installedMnemopiRoot = mnemopi;
		}
	} catch { /* Stock OMP is unavailable on this test host; positive proof runs on supported native hosts. */ }
}
const supportedTest = initBeam ? test : test.skip;
const secret = "Bearer syntheticbearerlettersonlyforevertoken";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const scratch = resolve(import.meta.dir, "../../var/agent-tmp");
	const root = mkdtempSync(join(scratch, "p29-audit-")); roots.push(root);
	const home = join(root, "home"), project = join(root, "project"), storeRoot = join(home, ".omp", "agent", "memories", "mnemopi");
	mkdirSync(storeRoot, { recursive: true }); mkdirSync(project);
	const args = { consent: "AUDIT_PRIVATE_MEMORY" as const, home, project, storeRoot, ompPath: installed };
	const dbFile = (name = "default") => name === "default" ? join(storeRoot, "mnemopi.db") : join(storeRoot, "banks", name, "mnemopi.db");
	const bank = (name = "default", working: string[] = [], episodic: string[] = []) => {
		const path = dbFile(name);
		mkdirSync(join(path, ".."), { recursive: true });
		const db = new Database(path);
		try {
			if (!initBeam) throw new Error("Reviewed Mnemopi schema source bytes unavailable");
			initBeam(db);
			for (const [index, content] of working.entries()) db.run("INSERT INTO working_memory (id, content) VALUES (?, ?)", [`w-${index}`, content]);
			for (const [index, content] of episodic.entries()) db.run("INSERT INTO episodic_memory (id, content) VALUES (?, ?)", [`e-${index}`, content]);
		} finally { db.close(); }
		return path;
	};
	return { root, home, project, storeRoot, args, bank, dbFile };
}

function seedReviewedOmp(root: string, version: string, changedSource?: string): string {
	if (!installedAgentRoot || !installedMnemopiRoot) throw new Error("Reviewed OMP source files unavailable");
	const agent = join(root, "node_modules/@oh-my-pi/pi-coding-agent");
	const mnemopi = join(agent, "node_modules/@oh-my-pi/pi-mnemopi");
	mkdirSync(join(agent, "dist"), { recursive: true });
	mkdirSync(mnemopi, { recursive: true });
	writeFileSync(join(agent, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }));
	writeFileSync(join(mnemopi, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-mnemopi", version }));
	const launcher = join(agent, "dist/cli.js");
	writeFileSync(launcher, "// inert test launcher");
	for (const [packageName, relativePath] of AUDIT_SOURCE_FILES) {
		const sourceRoot = packageName === "agent" ? installedAgentRoot : installedMnemopiRoot;
		const packageRoot = packageName === "agent" ? agent : mnemopi;
		const bytes = readFileSync(join(sourceRoot, relativePath));
		const target = join(packageRoot, relativePath);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, changedSource === packageName + "/" + relativePath ? Buffer.concat([bytes, Buffer.from("x")]) : bytes);
	}
	return launcher;
}
function snapshot(path: string): string[] {
	return readdirSync(path).sort().flatMap(name => {
		const child = join(path, name), s = lstatSync(child), prefix = `${name}:${s.mode & 0o777}:`;
		return s.isDirectory() ? [prefix + "dir", ...snapshot(child).map(row => `${name}/${row}`)] :
			[prefix + (s.isSymbolicLink() ? "link" : readFileSync(child).toString("hex"))];
	});
}

supportedTest("consent is an explicit literal; refusing it never reads or writes stores", async () => {
	const f = fixture(); f.bank("default", [secret]);
	const before = snapshot(f.root);
	const result = await auditMemoryAtRest({ ...f.args, consent: undefined });
	expect(result.status).toBe("UNVERIFIED");
	expect(result.reason).toBe("CONSENT_REQUIRED");
	expect(snapshot(f.root)).toEqual(before);
});

supportedTest("enumerates every supported bank; catches alphabetic bearer and both memory stores without leaking rows", async () => {
	const f = fixture();
	const pem = ["-----BEGIN ", "PRIVATE KEY-----\n", "syntheticprivatekeymaterialnotvalid", "\n-----END PRIVATE KEY-----"].join("");
	f.bank("default", ["public note", secret], [pem]);
	f.bank("project_A", [["password", "=", "syntheticlettersforpasswordvalue"].join("")], ["postgres://syntheticuser:syntheticpassword@invalid.example/test"]);
	const before = snapshot(f.root);
	const result = await auditMemoryAtRest({ ...f.args, expectedBanks: ["default", "project_A"] });
	expect(result.status).toBe("MATCHES");
	expect(result.version).toBe(installedVersion);
	expect(result.coverage).toEqual({ banks_discovered: 2, banks_scanned: 2, stores_discovered: 2, stores_scanned: 2,
		working_rows: 3, episodic_rows: 2, total_rows: 5, fields: ["working_memory.content", "episodic_memory.content"] });
	expect(result.categories).toEqual({ bearer_token: 1, private_key: 1, password_assignment: 1, credential_url: 1, provider_token: 0 });
	if (result.redactor?.coverage === "SYNTHETIC_ONLY") {
		expect(result.redactor.status).toBe("MISSES");
		expect(result.redactor.version).toBe(installedVersion);
		expect(result.redactor.missed).toContain("pem_private_key");
	} else {
		expect(result.redactor?.status).toBe("UNVERIFIED");
	}
	const text = JSON.stringify(result);
	for (const sensitive of [secret, pem, "syntheticlettersforpasswordvalue", "syntheticpassword", f.root, f.storeRoot]) expect(text).not.toContain(sensitive);
	expect(snapshot(f.root)).toEqual(before);
});

supportedTest("P29-FN-01: no-digit bearer control prevents a false clean verdict", async () => {
	const f = fixture(); f.bank("default", ["a harmless note"]);
	expect((await auditMemoryAtRest(f.args)).status).toBe("NO_MATCHES_IN_COVERED_CLASSES");
	// Historical redactor misses the no-digit bearer class. Omitting that detector
	// must change MATCHES to a false clean verdict, so this test is causal.
	const db = new Database(f.dbFile());
	try { db.run("INSERT INTO working_memory (id, content) VALUES (?, ?)", ["negative", secret]); } finally { db.close(); }
	const detected = await auditMemoryAtRest(f.args);
	expect(detected.status).toBe("MATCHES");
	expect(detected.categories.bearer_token).toBe(1);
	expect(detected.coverage?.total_rows).toBe(2);
});

supportedTest("incomplete banks, WAL, symlinks and unknown tables refuse a clean verdict", async () => {
	const absent = fixture(); absent.bank();
	expect((await auditMemoryAtRest({ ...absent.args, expectedBanks: ["default", "omitted"] })).status).toBe("UNVERIFIED");
	const wal = fixture(); wal.bank(); wal.bank("project_A");
	writeFileSync(`${wal.dbFile("project_A")}-wal`, "pending");
	expect((await auditMemoryAtRest(wal.args)).reason).toBe("UNSAFE_STORE");
	const linked = fixture(); linked.bank(); mkdirSync(join(linked.storeRoot, "banks")); symlinkSync(linked.dbFile(), join(linked.storeRoot, "banks", "linked"));
	expect((await auditMemoryAtRest(linked.args)).status).toBe("UNVERIFIED");
	const opaque = fixture(); opaque.bank();
	const db = new Database(opaque.dbFile()); try { db.run("CREATE TABLE private_unknown (content TEXT)"); } finally { db.close(); }
	expect((await auditMemoryAtRest(opaque.args)).reason).toBe("UNSUPPORTED_SCHEMA");
});

supportedTest("zero-byte WAL refuses a clean synthetic store verdict", async () => {
	const f = fixture(); f.bank();
	const walPath = `${f.dbFile()}-wal`;
	writeFileSync(walPath, Buffer.alloc(0));
	const before = snapshot(f.root);
	const result = await auditMemoryAtRest(f.args);
	expect(result.status).toBe("UNVERIFIED");
	expect(result.reason).toBe("UNSAFE_STORE");
	expect(result.coverage).toBeNull();
	expect(snapshot(f.root)).toEqual(before);
});

supportedTest("symlinked database file refuses a clean synthetic store verdict without disclosing the target", async () => {
	const f = fixture();
	const dbPath = f.bank();
	const target = join(f.home, "synthetic-mnemopi-target.db");
	writeFileSync(target, readFileSync(dbPath));
	rmSync(dbPath);
	symlinkSync(target, dbPath);
	const before = snapshot(f.root);
	const result = await auditMemoryAtRest(f.args);
	expect(result.status).toBe("UNVERIFIED");
	expect(result.reason).toBe("UNSAFE_STORE");
	expect(result.coverage).toBeNull();
	expect(JSON.stringify(result)).not.toContain(target);
	expect(snapshot(f.root)).toEqual(before);
});
supportedTest("a symlink in an ancestor of the selected store root cannot turn a clean audit into clearance", async () => {
	const f = fixture(); f.bank("default", ["harmless synthetic row"]);
	const alias = join(f.root, "linked-parent");
	symlinkSync(f.root, alias);
	const result = await auditMemoryAtRest({ ...f.args,
		home: join(alias, "home"),
		storeRoot: join(alias, "home", ".omp", "agent", "memories", "mnemopi"),
	});
	expect(result.status).toBe("UNVERIFIED");
	expect(result.reason).toBe("UNSAFE_STORE");
});

supportedTest("unreadable stores and unsupported OMP source bytes cannot be certified", async () => {
	const f = fixture(); f.bank(); chmodSync(f.dbFile(), 0o000);
	expect((await auditMemoryAtRest(f.args)).status).toBe("UNVERIFIED");
	const other = fixture(); other.bank();
	const result = await auditMemoryAtRest({ ...other.args, ompPath: join(other.root, "not-omp") });
	expect(result.status).toBe("UNVERIFIED");
	expect(result.reason).toBe("UNSUPPORTED_SOURCE");
});

supportedTest("reviewed audit source bytes ignore release version, but a byte change refuses", async () => {
	const reviewed = fixture(); reviewed.bank("default", ["ordinary synthetic row"]);
	const reviewedOmp = seedReviewedOmp(join(reviewed.root, "omp-reviewed"), "99.0.0");
	const covered = await auditMemoryAtRest({ ...reviewed.args, ompPath: reviewedOmp });
	expect(covered.status).toBe("NO_MATCHES_IN_COVERED_CLASSES");
	expect(covered.version).toBe("99.0.0");

	for (const changedSource of ["mnemopi/src/core/query-cache.ts", "mnemopi/src/db.ts", "mnemopi/src/core/episodic-graph.ts"]) {
		const changed = fixture(); changed.bank();
		const changedOmp = seedReviewedOmp(join(changed.root, "omp-changed"), "100.0.0", changedSource);
		const refused = await auditMemoryAtRest({ ...changed.args, ompPath: changedOmp });
		expect(refused.status).toBe("UNVERIFIED");
		expect(refused.reason).toBe("UNSUPPORTED_SOURCE");
		expect(refused.coverage).toBeNull();
	}
});

supportedTest("compiled private audit requires separate consent and exposes only covered counts without mutating the selected HOME", () => {
	const f = fixture();
	f.bank("default", [secret], ["ordinary episodic note"]);
	f.bank("project_A", [["password", "=", "syntheticlettersforpasswordvalue"].join("")]);
	const release = join(f.root, "release");
	mkdirSync(join(release, "bin"), { recursive: true });
	const binary = join(release, "bin", "omp-kit");
	const entry = resolve(import.meta.dir, "../../src/cli.ts");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", entry, "--outfile", binary], {
		cwd: f.root, env: { ...process.env, TMPDIR: f.root }, stdout: "pipe", stderr: "pipe",
	});
	expect(build.exitCode).toBe(0);
	const before = snapshot(f.root);
	const invoke = (args: string[]) => {
		const result = Bun.spawnSync([binary, "memory", "audit", "--store-root", f.storeRoot, ...args, "--json"], {
			cwd: f.project, env: { ...process.env, HOME: f.home, TMPDIR: f.root,
				XDG_CACHE_HOME: join(f.root, "xdg-cache"), XDG_STATE_HOME: join(f.root, "xdg-state") },
			stdout: "pipe", stderr: "pipe",
		});
		return { code: result.exitCode, text: result.stdout.toString() + result.stderr.toString(),
			envelope: JSON.parse(result.stdout.toString()) };
	};
	const refused = invoke([]);
	expect(refused.code).toBe(2);
	expect(refused.envelope.errors[0].code).toBe("CONSENT_REQUIRED");
	expect(snapshot(f.root)).toEqual(before);
	const covered = invoke(["--yes"]);
	expect(covered.code).toBe(1);
	expect(covered.envelope.data.audit.status).toBe("MATCHES");
	expect(covered.envelope.data.audit.coverage).toEqual({ banks_discovered: 2, banks_scanned: 2,
		stores_discovered: 2, stores_scanned: 2, working_rows: 2, episodic_rows: 1, total_rows: 3,
		fields: ["working_memory.content", "episodic_memory.content"] });
	expect(covered.envelope.data.audit.categories.bearer_token).toBe(1);
	for (const sensitive of [secret, "syntheticlettersforpasswordvalue", f.root, f.storeRoot])
		expect(covered.text).not.toContain(sensitive);
	expect(snapshot(f.root)).toEqual(before);
	writeFileSync(`${f.dbFile()}-wal`, "synthetic pending WAL bytes");
	const beforeWal = snapshot(f.root);
	const activeWal = invoke(["--yes"]);
	expect(activeWal.code).toBe(3);
	expect(activeWal.envelope.data.audit.status).toBe("UNVERIFIED");
	expect(activeWal.envelope.data.audit.reason).toBe("UNSAFE_STORE");
	expect(activeWal.text).not.toContain(f.root);
	expect(snapshot(f.root)).toEqual(beforeWal);
}, 30_000);

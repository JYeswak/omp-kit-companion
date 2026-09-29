import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseRuleOwnership, readManifest, type ManifestRule, type RuleOwnershipRecord } from "./diagnostics.ts";
import { applyMutation, planMutation, type FileMutation, type Image, type MutationPlan } from "./mutations.ts";

export type RuleAction = "install" | "update" | "retire" | "unchanged" | "unowned-identical" | "unowned-retired" | "collision";
export type RulePlanEntry = Readonly<{ name: string; path: string; action: RuleAction; beforeSha256: string | null; beforeMode: number | null; desiredSha256: string | null; desiredMode: number | null; owned: boolean }>;
export type RulePlan = Readonly<{ scope: "rules"; entries: readonly RulePlanEntry[]; unknownMarkdown: number; changes: number; blocked: boolean }>;
export type RuleReceipt = Readonly<{ status: "APPLIED" | "UNCHANGED"; id: string | null; files: number }>;
export type RuleInput = Readonly<{ root: string; home: string; stateRoot?: string }>;

type Ownership = RuleOwnershipRecord;
type Prepared = { input: RuleInput; sourceHash: string; inventoryHash: string; images: ReadonlyMap<string, Image | null>; ownershipImage: Image | null; mutation: MutationPlan | null };
const privatePlans = new WeakMap<RulePlan, Prepared>();
const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(code: "SOURCE_INVALID" | "STATE_UNSAFE" | "UNSAFE_PATH" | "RULE_COLLISION" | "FRESH_PLAN" | "INVALID_PLAN" | "RULES_FAILED"): never {
	throw new Error(code); // No absolute paths, file contents or arbitrary fs errors cross this seam.
}
function safeDirectories(path: string): void {
	if (!isAbsolute(path) || resolve(path) !== path) fail("UNSAFE_PATH");
	const parts: string[] = [];
	for (let cursor = path; cursor !== dirname(cursor); cursor = dirname(cursor)) parts.unshift(cursor);
	for (const part of parts) {
		let info;
		try { info = lstatSync(part); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			fail("UNSAFE_PATH");
		}
		if (!info.isDirectory() || info.isSymbolicLink()) fail("UNSAFE_PATH");
	}
}
function bytesOf(path: string, kind: "SOURCE_INVALID" | "STATE_UNSAFE" | "UNSAFE_PATH"): { bytes: Buffer; image: Image } | null {
	safeDirectories(dirname(path));
	let info;
	try { info = lstatSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		fail(kind);
	}
	if (!info.isFile() || info.isSymbolicLink()) fail(kind);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || info.ino !== opened.ino || info.dev !== opened.dev) fail(kind);
		const bytes = readFileSync(fd);
		const after = fstatSync(fd);
		if (after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail(kind);
		return { bytes, image: { sha256: hex(bytes), size: bytes.length, mode: opened.mode & 0o7777, uid: opened.uid, gid: opened.gid } };
	} finally { closeSync(fd); }
}
function ownership(path: string): { value: Ownership; image: Image | null } {
	const file = bytesOf(path, "STATE_UNSAFE");
	if (!file) return { value: { version: 1, rules: {} }, image: null };
	if (file.image.mode !== 0o600 || file.image.uid !== process.getuid?.()) fail("STATE_UNSAFE");
	return { value: parseRuleOwnership(file.bytes), image: file.image };
}
function same(a: Image, b: Image): boolean {
	return a.sha256 === b.sha256 && a.size === b.size && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}
function source(root: string): { rules: ManifestRule[]; retired: string[]; bytes: Map<string, Buffer>; hash: string } {
	safeDirectories(root);
	const manifest = readManifest(root);
	if (manifest.error) fail("SOURCE_INVALID");
	const manifestFile = bytesOf(join(root, "MANIFEST.tsv"), "SOURCE_INVALID");
	if (!manifestFile) fail("SOURCE_INVALID");
	const bytes = new Map<string, Buffer>();
	for (const rule of manifest.rules) {
		const file = bytesOf(join(root, "rules", `${rule.name}.md`), "SOURCE_INVALID");
		if (!file || file.image.sha256 !== rule.sha256) fail("SOURCE_INVALID");
		bytes.set(rule.name, file.bytes);
	}
	const retiredDir = join(root, "retired");
	safeDirectories(retiredDir);
	const retired: string[] = [], retirementHashes: string[] = [];
	const active = new Set(manifest.rules.map(rule => rule.name));
	let retiredEntries: string[];
	try {
		if (!lstatSync(retiredDir).isDirectory()) fail("SOURCE_INVALID");
		retiredEntries = readdirSync(retiredDir).sort();
	} catch { return fail("SOURCE_INVALID"); }
	for (const entry of retiredEntries) {
		if (!entry.endsWith(".md")) continue;
		const name = entry.slice(0, -3);
		const marker = bytesOf(join(retiredDir, entry), "SOURCE_INVALID");
		if (!namePattern.test(name) || active.has(name) || !marker) fail("SOURCE_INVALID");
		retired.push(name);
		retirementHashes.push(`${name}:${marker.image.sha256}`);
	}
	const signature = [manifestFile.image.sha256, ...manifest.rules.map(rule => `${rule.name}:${rule.sha256}`), ...retirementHashes].join("\n");
	return { rules: manifest.rules, retired, bytes, hash: hex(Buffer.from(signature)) };
}

/** Read-only, authority-aware preview; displayed paths are HOME-relative, never operator absolute paths. */
export function planRules(input: RuleInput): RulePlan {
	try {
		if (!isAbsolute(input.home) || !isAbsolute(input.root) || resolve(input.home) !== input.home || resolve(input.root) !== input.root || input.home === input.root || input.home === sep ||
			(input.stateRoot !== undefined && (!isAbsolute(input.stateRoot) || resolve(input.stateRoot) !== input.stateRoot))) fail("UNSAFE_PATH");
		safeDirectories(input.home);
		const pack = source(input.root);
		const target = join(input.home, ".agents", "rules");
		const stateRoot = input.stateRoot ?? join(input.home, ".local", "state", "omp-kit");
		if (stateRoot === target || stateRoot.startsWith(`${target}${sep}`) || target.startsWith(`${stateRoot}${sep}`) ||
			stateRoot === input.root || stateRoot.startsWith(`${input.root}${sep}`)) fail("UNSAFE_PATH");
		const recordPath = join(input.home, ".agents", "omp-kit-ownership.json");
		safeDirectories(target);
		const previous = ownership(recordPath);
		const entries: RulePlanEntry[] = [];
		const nextRules: Record<string, Image> = Object.assign(Object.create(null) as Record<string, Image>, previous.value.rules);
		const mutations: FileMutation[] = [];
		const images = new Map<string, Image | null>();
		const candidates = new Map(pack.rules.map(rule => [rule.name, rule]));
		const names = [...new Set([...candidates.keys(), ...pack.retired, ...Object.keys(nextRules)])].sort();
		for (const name of names) {
			const file = bytesOf(join(target, `${name}.md`), "UNSAFE_PATH");
			const before = file?.image ?? null;
			images.set(name, before);
			const owned = nextRules[name];
			const rule = candidates.get(name);
			let action: RuleAction;
			const desiredSha256 = rule?.sha256 ?? null;
			const desiredMode = rule ? 0o644 : null;
			if (owned && (!before || !same(before, owned))) action = "collision";
			else if (rule) {
				if (!before) action = "install";
				else if (!owned) action = before.sha256 === rule.sha256 ? "unowned-identical" : "collision";
				else action = before.sha256 === rule.sha256 ? "unchanged" : "update";
			} else if (!pack.retired.includes(name) && owned) action = "collision"; // Missing retirement authorization.
			else if (!before) action = "unchanged";
			else action = owned ? "retire" : "unowned-retired";
			entries.push(Object.freeze({ name, path: `.agents/rules/${name}.md`, action, beforeSha256: before?.sha256 ?? null, beforeMode: before?.mode ?? null, desiredSha256, desiredMode, owned: !!owned }));
			if (action === "install" || action === "update") {
				const data = pack.bytes.get(name)!;
				mutations.push({ root: "home", relativePath: `.agents/rules/${name}.md`, expectedBefore: before, after: { bytes: data, mode: 0o644 } });
				nextRules[name] = { sha256: rule!.sha256, size: data.length, mode: 0o644, uid: process.getuid!(), gid: process.getgid!() };
			} else if (action === "retire") {
				mutations.push({ root: "home", relativePath: `.agents/rules/${name}.md`, expectedBefore: before, after: null });
				delete nextRules[name];
			}
		}
		let unknownMarkdown = 0;
		let inventoryHash = "";
		try {
			const targetEntries = readdirSync(target).sort();
			inventoryHash = hex(Buffer.from(targetEntries.join("\n")));
			for (const name of targetEntries) if (name.endsWith(".md") && !names.includes(name.slice(0, -3))) unknownMarkdown++;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("UNSAFE_PATH");
			inventoryHash = hex(Buffer.alloc(0));
		}
		const blocked = entries.some(entry => entry.action === "collision");
		let mutation: MutationPlan | null = null;
		if (!blocked && mutations.length) {
			mutations.push({ root: "home", relativePath: ".agents/omp-kit-ownership.json", expectedBefore: previous.image,
				after: { bytes: Buffer.from(JSON.stringify({ version: 1, rules: Object.fromEntries(Object.entries(nextRules).sort(([a], [b]) => a.localeCompare(b))) }) + "\n"), mode: 0o600 } });
			mutation = planMutation({ stateRoot, roots: [{ id: "home", path: input.home }], files: mutations });
		}
		const plan: RulePlan = Object.freeze({ scope: "rules", entries: Object.freeze(entries), unknownMarkdown, changes: entries.filter(entry => entry.action === "install" || entry.action === "update" || entry.action === "retire").length, blocked });
		privatePlans.set(plan, { input: { ...input }, sourceHash: pack.hash, inventoryHash, images, ownershipImage: previous.image, mutation });
		return plan;
	} catch (error) {
		if (error instanceof Error && /^(SOURCE_INVALID|STATE_UNSAFE|UNSAFE_PATH|RULE_COLLISION|FRESH_PLAN|INVALID_PLAN|PENDING_RECOVERY)$/.test(error.message)) throw error;
		return fail("RULES_FAILED");
	}
}

/** Caller must obtain explicit CLI confirmation; no-op never takes a lock or alters state. */
export function applyRulePlan(plan: RulePlan, options: { confirmed: true }): RuleReceipt {
	if (options?.confirmed !== true) fail("INVALID_PLAN");
	const prepared = privatePlans.get(plan);
	if (!prepared) fail("INVALID_PLAN");
	if (plan.blocked) fail("RULE_COLLISION");
	const fresh = planRules(prepared.input);
	const next = privatePlans.get(fresh)!;
	if (next.sourceHash !== prepared.sourceHash || next.inventoryHash !== prepared.inventoryHash || JSON.stringify(fresh.entries) !== JSON.stringify(plan.entries)) fail("FRESH_PLAN");
	if (!prepared.mutation) return { status: "UNCHANGED", id: null, files: 0 };
	const result = applyMutation(prepared.mutation, { onBoundary: boundary => {
		try {
			if (source(prepared.input.root).hash !== prepared.sourceHash) fail("FRESH_PLAN");
			if (boundary === "pending-synced") {
				const target = join(prepared.input.home, ".agents", "rules");
				const present = (() => {
					try { return readdirSync(target).sort(); }
					catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
				})();
				if (hex(Buffer.from(present.join("\n"))) !== prepared.inventoryHash) fail("FRESH_PLAN");
				for (const [name, before] of prepared.images) {
					const current = bytesOf(join(target, `${name}.md`), "UNSAFE_PATH")?.image ?? null;
					if (before === null ? current !== null : !current || !same(before, current)) fail("FRESH_PLAN");
				}
				const currentRecord = ownership(join(prepared.input.home, ".agents", "omp-kit-ownership.json")).image;
				if (prepared.ownershipImage === null ? currentRecord !== null : !currentRecord || !same(prepared.ownershipImage, currentRecord)) fail("FRESH_PLAN");
			}
		} catch { fail("FRESH_PLAN"); }
	} });
	return { status: "APPLIED", id: result.id, files: result.files };
}

import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { ownedTmp } from "./kitlib/tmp.ts";
import { run } from "./kitlib/run.ts";
import { tarMembers } from "./kit-release.ts";
import { acquireRunLock } from "./service-run.ts";
import { releaseRoot } from "./paths.ts";
import { isSha256Hex, matchesBounded } from "./regex-guards.ts";
import type { CliResult, ParsedCommand } from "./cli.ts";

/** OVNFSTRACK1: ovnfs stays current by itself: proven swap with rollback, no permission repair. */
export const OVNFS_REPO = "stencil-hq/ovnfs";
export const TOOL_UPDATE_JOB = "tool-update";
export const TOOL_UPDATE_LOCK_CODE = "TOOL_UPDATE_BUSY";
export const TOOL_UPDATE_CHECKSUM_CODE = "TOOL_UPDATE_CHECKSUM_MISMATCH";
export const TOOL_UPDATE_LOAD_CODE = "TOOL_UPDATE_DAEMON_LOAD_FAILED";
export const TOOL_UPDATE_ROLLBACK_CODE = "TOOL_UPDATE_ROLLBACK_FAILED";
export const TOOL_UPDATE_LOOKUP_CODE = "TOOL_UPDATE_LOOKUP_FAILED";

const VERSION_OUTPUT = /^ovnfs v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\b/;
const VERSION_FULL = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const CHECKSUM_LINE = /^([a-f0-9]{64})[ \t*]+(\S+)$/;
const UNLINKAT_LINE = /^.*unlinkat ([^:]+): (permission denied|.*)$/;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_TAIL_BYTES = 8192;

export function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const x = pa[i] ?? 0, y = pb[i] ?? 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

export function parseOvnfsVersion(output: string): string | null {
	if (output.length > 4096) return null;
	const match = VERSION_OUTPUT.exec(output.trim());
	if (!match) return null;
	const version = match[1]!;
	return VERSION_FULL.test(version) ? version : null;
}

export function platformAssetName(version: string): { asset: string; checksums: string } | null {
	if (!VERSION_FULL.test(version) || version.length > 64) return null;
	return { asset: `ovnfs_${version}_darwin_arm64.tar.gz`, checksums: `ovnfs_${version}_checksums.txt` };
}

export function assetUrls(version: string): { assetUrl: string; checksumsUrl: string; skillUrl: string } | null {
	const names = platformAssetName(version);
	if (!names) return null;
	return {
		assetUrl: `https://github.com/${OVNFS_REPO}/releases/download/v${version}/${names.asset}`,
		checksumsUrl: `https://github.com/${OVNFS_REPO}/releases/download/v${version}/${names.checksums}`,
		skillUrl: `https://raw.githubusercontent.com/${OVNFS_REPO}/v${version}/skills/ovnfs/SKILL.md`,
	};
}

export function parseChecksums(text: string): Map<string, string> | null {
	if (text.length > 1024 * 1024) return null;
	const out = new Map<string, string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		if (!matchesBounded(trimmed, 512, CHECKSUM_LINE)) return null;
		const match = CHECKSUM_LINE.exec(trimmed)!;
		const digest = match[1]!, name = match[2]!;
		if (name.length > 255 || name.includes("/") || name.includes("\0")) return null;
		out.set(name, digest);
	}
	return out;
}

export function ovnfsBinFor(home: string): string {
	const override = process.env.OMP_KIT_OVNFS_BIN;
	if (typeof override === "string" && override !== "") return override;
	return join(home, ".local", "bin", "ovnfs");
}

export function ovnfsStateFor(home: string): string {
	const override = process.env.OMP_KIT_OVNFS_STATE;
	if (typeof override === "string" && override !== "") return override;
	const envState = process.env.OVNFS_STATE;
	if (typeof envState === "string" && envState !== "") return envState;
	return join(home, ".local", "state", "ovnfs");
}

/** Documented settings for the release-tagged ovnfs skill refresh: explicit
 * OMP_KIT_OVNFS_SKILL_DST wins; otherwise the packaged config/ovnfs.json
 * skill_store_subpath joined under HOME. Null when neither names a safe
 * home-relative destination; the update refuses before replacing anything. */
export function ovnfsSkillDstFor(home: string): string | null {
	const override = process.env.OMP_KIT_OVNFS_SKILL_DST;
	if (typeof override === "string" && override !== "") return override;
	const subpath = ovnfsSkillStoreSubpath();
	if (subpath === null) return null;
	return join(home, subpath, "ovnfs", "SKILL.md");
}

const SKILL_SUBPATH_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function ovnfsSkillStoreSubpath(): string | null {
	let raw: string;
	try {
		const root = ovnfsConfigRoot();
		if (root === null) return null;
		raw = readFileSync(join(root, "config", "ovnfs.json"), "utf8");
	} catch { return null; }
	if (raw.length === 0 || raw.length > 4096) return null;
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { return null; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const subpath = (parsed as Record<string, unknown>).skill_store_subpath;
	if (typeof subpath !== "string" || subpath.length === 0 || subpath.length > 256) return null;
	if (!SKILL_SUBPATH_PATTERN.test(subpath)) return null;
	// The pattern admits runs of dots; a "." or ".." segment would stay inside
	// or escape HOME when joined, so refuse dot-only segments explicitly.
	if (subpath.split("/").some(part => part === "." || part === "..")) return null;
	return subpath;
}

function ovnfsConfigRoot(): string | null {
	try {
		if (typeof Bun !== "undefined" && typeof Bun.main === "string") {
			if (Bun.main.endsWith(".ts")) return resolve(dirname(Bun.main), "..");
			return releaseRoot(process.execPath);
		}
	} catch { /* fall through to the source-relative root */ }
	try {
		return resolve(import.meta.dir, "..");
	} catch { return null; }
}

export function fakeReleaseDir(): string | null {
	const dir = process.env.OMP_KIT_OVNFS_FAKE_RELEASE_DIR;
	return typeof dir === "string" && dir !== "" ? dir : null;
}

export type OvnfsRun = (argv: readonly string[], options: { deadline_s: number; cwd?: string; env?: Record<string, string> }) => Promise<{ rc: number | null; stdout: Uint8Array; stderr: Uint8Array; timed_out: boolean }>;

async function defaultRun(argv: readonly string[], options: { deadline_s: number; cwd?: string; env?: Record<string, string> }) {
	return run(argv, { deadline_s: options.deadline_s, max_output_bytes: 1 << 20, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.env !== undefined ? { env: options.env } : {}) });
}

function textOf(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function withState(bin: string, stateDir: string | null, tail: readonly string[]): string[] {
	const head = stateDir !== null ? [bin, "--state", stateDir] : [bin];
	return [...head, ...tail];
}

export async function readInstalledVersion(bin: string, runner: OvnfsRun = defaultRun): Promise<string | null> {
	try {
		const result = await runner([bin, "version"], { deadline_s: 15 });
		if (result.rc !== 0 || result.timed_out) return null;
		return parseOvnfsVersion(textOf(result.stdout));
	} catch { return null; }
}

export type DaemonStatus = { ok: true; pid: number; checkouts: number; raw: string } | { ok: false; raw: string };

export async function readDaemonStatus(bin: string, stateDir: string | null, runner: OvnfsRun = defaultRun): Promise<DaemonStatus> {
	try {
		const result = await runner(withState(bin, stateDir, ["--json", "status"]), { deadline_s: 15 });
		const raw = `${textOf(result.stdout)}\n${textOf(result.stderr)}`.slice(0, 8192);
		if (result.rc !== 0 || result.timed_out) return { ok: false, raw };
		let parsed: unknown;
		try { parsed = JSON.parse(textOf(result.stdout)); } catch { return { ok: false, raw }; }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, raw };
		const record = parsed as Record<string, unknown>;
		if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) return { ok: false, raw };
		if (typeof record.checkouts !== "number" || !Number.isSafeInteger(record.checkouts) || record.checkouts < 0) return { ok: false, raw };
		return { ok: true, pid: record.pid, checkouts: record.checkouts, raw };
	} catch (error) {
		return { ok: false, raw: error instanceof Error ? error.message.slice(0, 1024) : "status failed" };
	}
}

export type CheckoutNames = { ok: true; names: string[]; count: number } | { ok: false; names: []; count: -1 };

export async function readCheckoutNames(bin: string, stateDir: string | null, runner: OvnfsRun = defaultRun): Promise<CheckoutNames> {
	try {
		const result = await runner(withState(bin, stateDir, ["--json", "ls"]), { deadline_s: 15 });
		if (result.rc !== 0 || result.timed_out) return { ok: false, names: [], count: -1 };
		let parsed: unknown;
		try { parsed = JSON.parse(textOf(result.stdout)); } catch { return { ok: false, names: [], count: -1 }; }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, names: [], count: -1 };
		const rows = (parsed as Record<string, unknown>).checkouts;
		if (!Array.isArray(rows)) return { ok: false, names: [], count: -1 };
		const names: string[] = [];
		for (const row of rows) {
			if (row === null || typeof row !== "object" || Array.isArray(row)) return { ok: false, names: [], count: -1 };
			const name = (row as Record<string, unknown>).name;
			if (typeof name !== "string" || name.length === 0 || name.length > 128) return { ok: false, names: [], count: -1 };
			names.push(name);
		}
		return { ok: true, names, count: names.length };
	} catch { return { ok: false, names: [], count: -1 }; }
}

export function loadFactor(): number {
	try {
		const load1 = loadavg()[0] ?? 0;
		const ncpu = availableParallelism();
		if (!Number.isFinite(load1) || !Number.isFinite(ncpu) || ncpu <= 0) return 1;
		return Math.max(1, Math.min(4, (load1 / ncpu) * 4));
	} catch { return 1; }
}

async function sleepMs(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	await promise;
}

export async function proveLoaded(bin: string, stateDir: string | null, expectedCheckouts: number, runner: OvnfsRun = defaultRun, deadlineS = 30 * loadFactor()): Promise<DaemonStatus> {
	const start = Date.now();
	let last: DaemonStatus = { ok: false, raw: "no status attempt" };
	while ((Date.now() - start) / 1000 < deadlineS) {
		last = await readDaemonStatus(bin, stateDir, runner);
		if (last.ok && last.checkouts === expectedCheckouts) return last;
		await sleepMs(1000);
	}
	return last;
}

/** A daemon that answers status at all is up; the checkout count is judged separately. */
export async function proveUp(bin: string, stateDir: string | null, runner: OvnfsRun = defaultRun, deadlineS = 30 * loadFactor()): Promise<DaemonStatus> {
	const start = Date.now();
	let last: DaemonStatus = { ok: false, raw: "no status attempt" };
	while ((Date.now() - start) / 1000 < deadlineS) {
		last = await readDaemonStatus(bin, stateDir, runner);
		if (last.ok) return last;
		await sleepMs(1000);
	}
	return last;
}

export type SwapVerdict =
	| { verdict: "MATCHED"; status: Extract<DaemonStatus, { ok: true }> }
	| { verdict: "DRIFTED"; status: Extract<DaemonStatus, { ok: true }>; names: string[] }
	| { verdict: "VANISHED"; vanished: string[] }
	| { verdict: "DOWN" };

/**
 * Prove the post-restart swap without waiting out the bound for a verdict the
 * daemon already gave: an answering daemon with the same count matches at
 * once; an answering daemon whose live names still cover every pre-swap
 * checkout drift-accepts at once; an answering daemon that lost pre-swap
 * checkouts vanishes at once. Only silence waits out the bound.
 */
export async function proveSwap(bin: string, stateDir: string | null, beforeCheckouts: number, liveNames: readonly string[], runner: OvnfsRun = defaultRun, deadlineS = 30 * loadFactor()): Promise<SwapVerdict> {
	const start = Date.now();
	for (;;) {
		const status = await readDaemonStatus(bin, stateDir, runner);
		if (status.ok) {
			if (status.checkouts === beforeCheckouts) return { verdict: "MATCHED", status };
			const names = await readCheckoutNames(bin, stateDir, runner);
			if (names.ok && liveNames.every(name => names.names.includes(name))) return { verdict: "DRIFTED", status, names: names.names };
			return { verdict: "VANISHED", vanished: liveNames.filter(name => !(names.ok && names.names.includes(name))) };
		}
		if ((Date.now() - start) / 1000 >= deadlineS) return { verdict: "DOWN" };
		await sleepMs(1000);
	}
}

export function readServeTail(stateDir: string): string {
	try {
		const path = join(stateDir, "serve.log");
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const size = fstatSync(fd).size;
			const start = Math.max(0, size - MAX_TAIL_BYTES);
			const length = Math.min(size, MAX_TAIL_BYTES);
			const buffer = Buffer.alloc(length);
			let read = 0;
			while (read < length) {
				const count = readSync(fd, buffer, read, length - read, start + read);
				if (count <= 0) break;
				read += count;
			}
			return buffer.subarray(0, read).toString("utf8");
		} finally { closeSync(fd); }
	} catch { return ""; }
}

export type BlockedUpper = { path: string; checkout: string; live: boolean };

export function blockedUppers(tail: string, liveNames: readonly string[]): { lines: string[]; uppers: BlockedUpper[] } {
	const lines: string[] = [];
	const uppers: BlockedUpper[] = [];
	const seen = new Set<string>();
	for (const line of tail.split("\n")) {
		if (line.length === 0 || line.length > 2048) continue;
		if (!line.includes("unlinkat") || !line.includes("uppers/")) continue;
		const match = UNLINKAT_LINE.exec(line);
		if (!match) continue;
		lines.push(line.slice(0, 1024));
		const full = match[1]!;
		const marker = "uppers/";
		const at = full.indexOf(marker);
		if (at < 0) continue;
		const rest = full.slice(at + marker.length);
		const checkout = rest.split("/")[0] ?? "";
		if (checkout === "" || seen.has(full)) continue;
		seen.add(full);
		uppers.push({ path: full.slice(0, 1024), checkout: checkout.slice(0, 128), live: liveNames.includes(checkout) });
		if (lines.length >= 20 || uppers.length >= 20) break;
	}
	return { lines, uppers };
}

async function fetchBytesBounded(url: string, maxBytes: number): Promise<Buffer> {
	const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length > maxBytes || buffer.length === 0) throw new Error("download size refused");
	return buffer;
}

async function fetchTextBounded(url: string, maxBytes: number): Promise<string> {
	const bytes = await fetchBytesBounded(url, maxBytes);
	return bytes.toString("utf8");
}

export type LatestRelease = { version: string; tag: string };

/** Explicit caller identity for the publisher API; the token, when the
 * operator provides one, travels only in the Authorization header and never
 * in errors, receipts or logs. Exported so tests can assert the contract. */
export function githubApiHeaders(): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": `omp-kit/${kitVersionForUserAgent()}` };
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (typeof token === "string" && token !== "") headers.Authorization = `Bearer ${token}`;
	return headers;
}

function kitVersionForUserAgent(): string {
	try {
		const root = ovnfsConfigRoot();
		if (root === null) return "unreleased";
		const raw = readFileSync(join(root, "package.json"), "utf8");
		if (raw.length === 0 || raw.length > 8192) return "unreleased";
		const parsed: unknown = JSON.parse(raw);
		const version = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).version : null;
		return typeof version === "string" && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ? version : "unreleased";
	} catch { return "unreleased"; }
}

export function githubApiBase(): string {
	const base = process.env.OMP_KIT_OVNFS_GITHUB_API;
	if (typeof base === "string" && base !== "") return base.replace(/\/+$/, "");
	return "https://api.github.com";
}

export async function resolveLatestRelease(): Promise<LatestRelease> {
	const fake = fakeReleaseDir();
	if (fake !== null) {
		const raw = readFileSync(join(fake, "latest.json"), "utf8");
		if (raw.length > 4096) throw new Error("fake latest.json oversized");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fake latest.json invalid");
		const version = (parsed as Record<string, unknown>).version;
		if (typeof version !== "string" || !VERSION_FULL.test(version)) throw new Error("fake version invalid");
		return { version, tag: `v${version}` };
	}
	const response = await fetch(`${githubApiBase()}/repos/${OVNFS_REPO}/releases/latest`, {
		signal: AbortSignal.timeout(30_000),
		headers: githubApiHeaders(),
	});
	if (!response.ok) throw new Error(`release lookup HTTP ${response.status}`);
	const text = await response.text();
	if (text.length > 256 * 1024) throw new Error("release lookup oversized");
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("release lookup invalid");
	const tag = (parsed as Record<string, unknown>).tag_name;
	if (typeof tag !== "string" || tag.length > 64) throw new Error("release tag invalid");
	const version = tag.startsWith("v") ? tag.slice(1) : tag;
	if (!VERSION_FULL.test(version)) throw new Error("release version invalid");
	return { version, tag };
}

export type ReleaseFiles = { asset: Buffer; checksumsText: string; skillText: string; assetName: string };

export async function downloadRelease(version: string): Promise<ReleaseFiles> {
	const fake = fakeReleaseDir();
	const names = platformAssetName(version);
	if (!names) throw new Error("platform unsupported");
	if (fake !== null) {
		const asset = readFileSync(join(fake, names.asset));
		if (asset.length === 0 || asset.length > MAX_DOWNLOAD_BYTES) throw new Error("fake asset size refused");
		const checksumsText = readFileSync(join(fake, names.checksums), "utf8");
		if (checksumsText.length === 0 || checksumsText.length > 1024 * 1024) throw new Error("fake checksums size refused");
		const skillText = readFileSync(join(fake, "SKILL.md"), "utf8");
		if (skillText.length === 0 || skillText.length > MAX_SKILL_BYTES) throw new Error("fake skill size refused");
		return { asset: Buffer.from(asset), checksumsText, skillText, assetName: names.asset };
	}
	const urls = assetUrls(version);
	if (!urls) throw new Error("platform unsupported");
	const [asset, checksumsText, skillText] = await Promise.all([
		fetchBytesBounded(urls.assetUrl, MAX_DOWNLOAD_BYTES),
		fetchTextBounded(urls.checksumsUrl, 1024 * 1024),
		fetchTextBounded(urls.skillUrl, MAX_SKILL_BYTES),
	]);
	return { asset, checksumsText, skillText, assetName: names.asset };
}

export function extractBinary(asset: Buffer): Buffer {
	const members = tarMembers(asset);
	const binary = members.find(member => member.path === "ovnfs" && member.kind === "file");
	if (!binary || binary.bytes.length === 0 || binary.bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("binary member missing");
	return Buffer.from(binary.bytes);
}

export type ToolUpdateInput = {
	home: string;
	mode: "plan" | "apply";
	deferSwapOnHighLoad?: boolean;
	load1?: number;
	ncpu?: number;
	runner?: OvnfsRun;
};

export type ToolUpdateResult =
	| { status: "CURRENT"; exitCode: 0; installed: string; latest: string }
	| { status: "UPDATE_AVAILABLE"; exitCode: 0; installed: string; latest: string; asset: string; daemon: string; skill: string }
	| { status: "UPDATED"; exitCode: 0; installed: string; latest: string; checkouts: number; pid: number; skill: string; prev: string; swap: "SWAPPED" | "BINARY_ONLY"; drift?: { before: number; after: number } }
	| { status: "DEFERRED_LOAD"; exitCode: 0; installed: string; latest: string; checkouts: number; detail: string }
	| { status: "REFUSED"; exitCode: 2; code: string; reason: string }
	| { status: "FAILED"; exitCode: 1; code: string; reason: string; blockerLines: string[]; uppers: BlockedUpper[]; restored: boolean; loaded: boolean };

function refusal(code: string, reason: string): ToolUpdateResult {
	return { status: "REFUSED", exitCode: 2, code, reason };
}

function failure(code: string, reason: string, blockerLines: string[] = [], uppers: BlockedUpper[] = [], restored = false, loaded = false): ToolUpdateResult {
	return { status: "FAILED", exitCode: 1, code, reason, blockerLines, uppers, restored, loaded };
}

export async function runToolUpdate(input: ToolUpdateInput): Promise<ToolUpdateResult> {
	const runner = input.runner ?? defaultRun;
	const bin = ovnfsBinFor(input.home);
	const stateDir = ovnfsStateFor(input.home);
	const skillDst = ovnfsSkillDstFor(input.home);
	if (!isAbsolute(bin) || resolve(bin) !== bin) return refusal("TOOL_UPDATE_BIN_UNSAFE", `ovnfs binary path is not absolute and canonical: ${bin.slice(0, 256)}`);
	if (!isAbsolute(stateDir) || resolve(stateDir) !== stateDir) return refusal("TOOL_UPDATE_STATE_UNSAFE", `ovnfs state path is not absolute and canonical: ${stateDir.slice(0, 256)}`);
	const installed = await readInstalledVersion(bin, runner);
	if (installed === null) return refusal("TOOL_UPDATE_VERSION_UNVERIFIED", `could not parse ${bin.slice(0, 256)} version; no download started`);
	let latest: LatestRelease;
	try { latest = await resolveLatestRelease(); }
	catch (error) { return refusal(TOOL_UPDATE_LOOKUP_CODE, error instanceof Error ? error.message.slice(0, 512) : "release lookup failed"); }
	if (compareSemver(latest.version, installed) <= 0) return { status: "CURRENT", exitCode: 0, installed, latest: latest.version };
	const names = platformAssetName(latest.version);
	if (!names) return refusal("TOOL_UPDATE_PLATFORM_UNSUPPORTED", "only darwin_arm64 is packaged by this updater");
	if (skillDst === null) return refusal("TOOL_UPDATE_SKILL_DST_UNVERIFIED", "no ovnfs skill destination: set OMP_KIT_OVNFS_SKILL_DST or ship config/ovnfs.json with skill_store_subpath; nothing was replaced");
	if (input.mode === "plan") {
		return { status: "UPDATE_AVAILABLE", exitCode: 0, installed, latest: latest.version, asset: names.asset, daemon: stateDir, skill: skillDst };
	}
	let files: ReleaseFiles;
	try { files = await downloadRelease(latest.version); }
	catch (error) { return refusal("TOOL_UPDATE_DOWNLOAD_FAILED", error instanceof Error ? error.message.slice(0, 512) : "download failed"); }
	const table = parseChecksums(files.checksumsText);
	if (table === null) return refusal(TOOL_UPDATE_CHECKSUM_CODE, "publisher checksums file did not parse; nothing was replaced");
	const expected = table.get(files.assetName);
	const actual = createHash("sha256").update(files.asset).digest("hex");
	if (!expected || !isSha256Hex(expected) || expected !== actual) {
		return refusal(TOOL_UPDATE_CHECKSUM_CODE, `checksum mismatch for ${files.assetName}: expected ${expected ?? "absent"}; actual ${actual}; nothing was replaced`);
	}
	let binary: Buffer;
	try { binary = extractBinary(files.asset); }
	catch (error) { return refusal("TOOL_UPDATE_ARCHIVE_INVALID", error instanceof Error ? error.message.slice(0, 512) : "archive invalid"); }
	if (files.skillText.length < 16 || !files.skillText.includes("ovnfs")) {
		return refusal("TOOL_UPDATE_SKILL_UNVERIFIED", "release skill did not look like the ovnfs skill; nothing was replaced");
	}
	const prev = `${bin}.prev`;
	const work = ownedTmp("tool-update");
	try {
		try {
			if (!existsSync(bin)) return refusal("TOOL_UPDATE_BIN_ABSENT", `ovnfs binary is absent at ${bin.slice(0, 256)}; nothing was replaced`);
			const beforeBytes = readFileSync(bin);
			if (beforeBytes.length === 0 || beforeBytes.length > MAX_DOWNLOAD_BYTES) return refusal("TOOL_UPDATE_BIN_UNVERIFIED", "installed binary size refused; nothing was replaced");
			atomicReplaceBytes(prev, beforeBytes, { mode: 0o755, durability: "none" });
			try { chmodSync(prev, 0o755); } catch { /* keep the atomic mode; exec bit loss is a rollback failure below */ }
			atomicReplaceBytes(bin, binary, { mode: 0o755, durability: "full" });
			try { chmodSync(bin, 0o755); } catch { /* same */ }
			mkdirSync(dirname(skillDst), { recursive: true, mode: 0o755 });
			atomicReplaceBytes(skillDst, Buffer.from(files.skillText, "utf8"), { mode: 0o644, durability: "full" });
		} catch (error) {
			return refusal("TOOL_UPDATE_BIN_UNSAFE", `install path refused (${error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256)}); a symlinked or non-canonical binary path is never written through`);
		}
	} finally { work.cleanup(); }
	const beforeStatus = await readDaemonStatus(bin, stateDir, runner);
	if (!beforeStatus.ok) {
		return { status: "UPDATED", exitCode: 0, installed, latest: latest.version, checkouts: -1, pid: -1, skill: skillDst, prev, swap: "BINARY_ONLY" };
	}
	const beforeCheckouts = beforeStatus.checkouts;
	const live = await readCheckoutNames(bin, stateDir, runner);
	const liveNames = live.ok ? live.names : [];
	if (input.deferSwapOnHighLoad === true) {
		const load1 = input.load1 ?? loadavg()[0] ?? 0;
		const ncpu = input.ncpu ?? availableParallelism();
		if (Number.isFinite(load1) && Number.isFinite(ncpu) && ncpu > 0 && load1 > 2.5 * ncpu) {
			return { status: "DEFERRED_LOAD", exitCode: 0, installed, latest: latest.version, checkouts: beforeCheckouts, detail: `SKIPPED-SWAP load1 ${load1} exceeds 2.5x cores (${ncpu}); binary and skill are new, the daemon swap is deferred to the next quiet tick` };
		}
	}
	const restart = await runner(withState(bin, stateDir, ["restart"]), { deadline_s: 60 });
	if (restart.rc !== 0 || restart.timed_out) {
		const tail = readServeTail(stateDir);
		const blocked = blockedUppers(tail, liveNames);
		return await rollback(bin, stateDir, runner, TOOL_UPDATE_LOAD_CODE, `restart exited ${restart.rc ?? "null"}; new daemon did not take over`, blocked, tail);
	}
	const proven = await proveSwap(bin, stateDir, beforeCheckouts, liveNames, runner);
	if (proven.verdict === "MATCHED") {
		return { status: "UPDATED", exitCode: 0, installed, latest: latest.version, checkouts: proven.status.checkouts, pid: proven.status.pid, skill: skillDst, prev, swap: "SWAPPED" };
	}
	if (proven.verdict === "DRIFTED") {
		return { status: "UPDATED", exitCode: 0, installed, latest: latest.version, checkouts: proven.status.checkouts, pid: proven.status.pid, skill: skillDst, prev, swap: "SWAPPED", drift: { before: beforeCheckouts, after: proven.status.checkouts } };
	}
	const tail = readServeTail(stateDir);
	const blocked = blockedUppers(tail, liveNames);
	const reason = proven.verdict === "VANISHED"
		? `pre-swap checkouts vanished after restart: ${proven.vanished.join(", ").slice(0, 512)}; restored the previous binary`
		: "new daemon did not prove loaded within the bound; restored the previous binary";
	return await rollback(bin, stateDir, runner, TOOL_UPDATE_LOAD_CODE, reason, blocked, tail);
}

async function rollback(bin: string, stateDir: string, runner: OvnfsRun, code: string, reason: string, blocked: { lines: string[]; uppers: BlockedUpper[] }, tail: string): Promise<ToolUpdateResult> {
	if (process.env.OMP_KIT_OVNFS_DISABLE_ROLLBACK === "1") {
		const lines = blocked.lines.length > 0 ? blocked.lines : tail.split("\n").filter(line => line.includes("uppers/")).slice(-5).map(line => line.slice(0, 1024));
		return failure(code, `${reason}; rollback disabled by test seam, daemon left down; serve.log tail: ${lines.join(" | ").slice(0, 2048)}`, lines, blocked.uppers, false, false);
	}
	const prev = `${bin}.prev`;
	try {
		const prevBytes = readFileSync(prev);
		if (prevBytes.length === 0) throw new Error("prev empty");
		atomicReplaceBytes(bin, prevBytes, { mode: 0o755, durability: "full" });
		try { chmodSync(bin, 0o755); } catch { /* best effort */ }
	} catch (error) {
		return failure(TOOL_UPDATE_ROLLBACK_CODE, `rollback could not restore ${prev.slice(0, 256)}: ${error instanceof Error ? error.message.slice(0, 512) : String(error)}`, blocked.lines, blocked.uppers, false, false);
	}
	await runner(withState(bin, stateDir, ["start"]), { deadline_s: 60 });
	const final = await proveUp(bin, stateDir, runner);
	const blockerText = blocked.lines.length > 0 ? blocked.lines.join(" | ").slice(0, 2048) : "no unlinkat blocker line in serve.log tail";
	const upperText = blocked.uppers.length > 0
		? blocked.uppers.map(upper => `${upper.path} (${upper.live ? `live checkout ${upper.checkout}` : `orphan upper ${upper.checkout}, absent from live ls`})`).join("; ").slice(0, 2048)
		: "no upper path parsed";
	const message = `${reason}; serve.log: ${blockerText}; uppers: ${upperText}; no file mode was changed`;
	return failure(code, message, blocked.lines, blocked.uppers, true, final.ok);
}

export function jobsDirFor(home: string): string {
	const base = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
	return join(base, "omp-kit", "jobs");
}

export async function toolsUpdateCommand(request: ParsedCommand): Promise<CliResult> {
	const home = process.env.HOME ?? "";
	const mode = request.flags.has("--apply") ? "apply" : "plan";
	if (request.argument !== undefined && request.argument !== "" && request.argument !== "ovnfs") {
		return { code: 2, data: { overall: "REFUSED", tool: request.argument, reason: "only ovnfs is updated by this command" }, errors: [{ code: "TOOL_UPDATE_NAME", message: `unknown tool ${request.argument}`, remediation: "Run omp-kit tools update ovnfs --plan." }], verification: "UNVERIFIED" };
	}
	if (mode === "apply") {
		try { mkdirSync(jobsDirFor(home), { recursive: true, mode: 0o700 }); } catch { /* acquire reports */ }
		const claimed = acquireRunLock(jobsDirFor(home), TOOL_UPDATE_JOB);
		if (claimed.status !== "ACQUIRED") {
			return { code: 4, data: { overall: "REFUSED", tool: "ovnfs", status: "REFUSED", exitCode: 4, code: TOOL_UPDATE_LOCK_CODE, reason: `another tool-update holds the lock (holder_pid=${claimed.holderPid ?? "unknown"}); no file was replaced` }, errors: [{ code: TOOL_UPDATE_LOCK_CODE, message: "another tool-update holds the lock", remediation: "Wait for the holder to finish, then retry; no file was replaced." }], verification: "UNVERIFIED" };
		}
		try {
			const result = await runToolUpdate({ home, mode });
			return toolUpdateResult(result);
		} finally { claimed.lock.release(); }
	}
	const result = await runToolUpdate({ home, mode });
	return toolUpdateResult(result);
}

function toolUpdateResult(result: ToolUpdateResult): CliResult {
	switch (result.status) {
		case "CURRENT": return { code: 0, data: { overall: "CURRENT", tool: "ovnfs", ...result, text: `ovnfs ${result.installed} is current` }, verification: "UNVERIFIED" };
		case "UPDATE_AVAILABLE": return { code: 0, data: { overall: "UPDATE_AVAILABLE", tool: "ovnfs", ...result, text: `ovnfs ${result.installed} -> ${result.latest} available` }, verification: "UNVERIFIED" };
		case "UPDATED": return { code: 0, data: { overall: "UPDATED", tool: "ovnfs", ...result, text: `ovnfs ${result.installed} -> ${result.latest} ${result.swap}${result.swap === "SWAPPED" && result.drift !== undefined ? `; checkout count ${result.drift.before} -> ${result.drift.after} during swap, all pre-swap checkouts present` : ""}` }, verification: "UNVERIFIED" };
		case "DEFERRED_LOAD": return { code: 0, data: { overall: "DEFERRED_LOAD", tool: "ovnfs", ...result, text: result.detail }, verification: "UNVERIFIED" };
		case "REFUSED": return { code: 2, data: { overall: "REFUSED", tool: "ovnfs", ...result }, errors: [{ code: result.code, message: result.reason, remediation: "No file was replaced; read the reason and retry." }], verification: "UNVERIFIED" };
		case "FAILED": return { code: 1, data: { overall: "FAILED", tool: "ovnfs", ...result }, errors: [{ code: result.code, message: result.reason, remediation: "The previous binary was restored; inspect serve.log uppers and remove the orphan upper after deciding." }], verification: "UNVERIFIED" };
	}
}

/** Byte-compatible spool writer for command-center producers (bead ompkit-fp72.120.16.11.3).
 *
 * Mirrors `Spool` in omp-kit `scripts/cc/cclib.py` without depending on the fleet:
 * `make_id = sha256(producer\x1fposition\x1ftype)[:32]`; canonical JSON with sorted keys,
 * `,`/`:` separators, raw non-ASCII, NaN/Infinity refused; envelope fields exactly as
 * `Spool.envelope`; day files under `<state>/spool/<producer>/<YYYY-MM-DD>.jsonl` named for
 * the day of append, never regressing below the newest existing day; unterminated tails
 * terminated first; one O_APPEND write per batch plus fsync.
 *
 * Credential screen reuses the companion `looksSecret` (mcp-sources.ts): a matching line is
 * replaced by a `cc.unknown` U-redaction envelope, identical in shape to cclib's.
 *
 * The TS side never loads the registry: producers, owners, and the emitted type shapes
 * (`action.attempt`, `action.result`, `source.tick`, `cc.unknown`) are hard-coded below from
 * `docs/command-center/schema/events.v1.json` (`omp-kit.cc.events.v1`); the ingester remains
 * the validator (anything drifting goes to dead letter + U-invalid).
 *
 * Inert without the fleet: `ccSpool` returns null unless the state dir exists AND contains
 * `spool/` AND `OMP_KIT_CC != '0'`. The state root itself is never created.
 *
 * Never throws to the caller: every append-path failure is swallowed into `adapter.failures`,
 * because a telemetry fault must not change a verb's exit code. `envelope()` throws only on
 * programming errors (undeclared producer/type, malformed data) before any byte is written.
 */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	statSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksSecret } from "./mcp-sources.ts";

export const CC_SPOOL_SCHEMA = "omp-kit.cc.events.v1";

const SPEC_VERSION = "1.0";

/** Declared producers, copied from events.v1.json at CC_SPOOL_SCHEMA. Undeclared names are refused. */
const PRODUCER_OWNERS: Record<string, string> = {
	tern: "StormyKnoll",
	session: "StormyKnoll",
	tracker: "PeachLeopard",
	git: "PeachLeopard",
	ci: "PeachLeopard",
	release: "RusticPine",
	host: "QuietBadger",
	mail: "QuietBadger",
	services: "QuietBadger",
	watcher: "PeachLeopard",
	config: "PeachLeopard",
	annotations: "PeachLeopard",
	cc: "PeachLeopard",
	selftest: "PeachLeopard",
	kit: "RusticPine",
	hooks: "PeachLeopard",
	jobs: "QuietBadger",
	closeguard: "PeachLeopard",
};

/** Emitted type versions, copied from events.v1.json at CC_SPOOL_SCHEMA. */
const TYPE_VERSIONS: Record<string, number> = {
	"action.attempt": 1,
	"action.result": 1,
	"bead.status": 1,
	"source.tick": 1,
	"cc.unknown": 1,
};

const REDACTION_ROUTE = "fix the producer's allowlist; send exposure metadata (never the value) to PeachLeopard";

export function makeId(producer: string, position: string, type: string): string {
	return createHash("sha256").update(`${producer}\x1f${position}\x1f${type}`, "utf8").digest("hex").slice(0, 32);
}

/** Day files `<YYYY-MM-DD>.jsonl`; anchored full-match, explicit ASCII classes, no nesting (linear). */
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Byte-stable JSON matching cclib.canonical: sorted keys, `,`/`:` separators, raw non-ASCII. */

export function canonical(value: unknown): string {
	return canonicalValue(value);
}

function canonicalValue(value: unknown): string {
	if (value === null) return "null";
	if (value === true) return "true";
	if (value === false) return "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
		return JSON.stringify(value);
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
	if (typeof value === "object") {
		const keys = codePointSort(Object.keys(value as Record<string, unknown>));
		const out = keys.map((k) => `${JSON.stringify(k)}:${canonicalValue((value as Record<string, unknown>)[k])}`);
		return `{${out.join(",")}}`;
	}
	throw new TypeError(`not JSON-serializable: ${typeof value}`);
}

/** Sort by Unicode code points, matching Python's `sorted()` on `str`. */
function codePointSort(keys: string[]): string[] {
	const split = keys.map((k) => ({ k, pts: Array.from(k) }));
	split.sort((a, b) => {
		const n = Math.min(a.pts.length, b.pts.length);
		for (let i = 0; i < n; i++) {
			if (a.pts[i] !== b.pts[i]) return a.pts[i]! < b.pts[i]! ? -1 : 1;
		}
		return a.pts.length - b.pts.length;
	});
	return split.map((s) => s.k);
}

export function isoMs(ms: number): string {
	return new Date(ms).toISOString();
}

export interface EnvelopeOptions {
	key: string;
	timeMs: number;
	observedMs?: number;
	source?: string;
	confidence?: "exact" | "derived" | "inferred";
	ctx?: Record<string, unknown>;
}

export interface CcSpool {
	readonly producer: string;
	/** Count of swallowed append-path failures; a telemetry fault never changes the verb's exit code. */
	failures: number;
	envelope(type: string, data: Record<string, unknown>, opts: EnvelopeOptions): Record<string, unknown>;
	append(envs: Array<Record<string, unknown>>): number;
}

export interface CcSpoolOptions {
	/** Override the state dir (default: `$CC_STATE` or `~/.local/state/omp-kit/cc`). */
	stateDir?: string;
	/** Override the clock (default: `Date.now`); tests plant it for the newest-day rule. */
	clock?: () => number;
}


/** State dir: `$CC_STATE`, else `~/.local/state/omp-kit/cc` (mirrors cclib.default_state). */
export function defaultStateDir(): string {
	const fromEnv = process.env.CC_STATE;
	if (fromEnv) return fromEnv;
	return join(process.env.HOME ?? tmpdir(), ".local/state/omp-kit/cc");
}

function checkNoSymlink(...paths: string[]): void {
	for (const p of paths) {
		if (lstatSync(p).isSymbolicLink()) throw new Error(`refusing symlink: ${p}`);
	}
}

function checkDataShape(type: string, data: Record<string, unknown>): void {
	const need: Record<string, (v: unknown) => boolean> = {
		"action.attempt": (d) =>
			typeof (d as Record<string, unknown>).action_id === "string" &&
			typeof (d as Record<string, unknown>).surface === "string",
		"action.result": (d) =>
			typeof (d as Record<string, unknown>).action_id === "string" &&
			typeof (d as Record<string, unknown>).outcome === "string" &&
			typeof (d as Record<string, unknown>).duration_ms === "number",
		"bead.status": (d) =>
			typeof (d as Record<string, unknown>).to_status === "string" &&
			typeof (d as Record<string, unknown>).observation === "string",
		"source.tick": (d) =>
			typeof (d as Record<string, unknown>).instance === "string" &&
			typeof (d as Record<string, unknown>).records_seen === "number",
		"cc.unknown": (d) =>
			typeof (d as Record<string, unknown>).class === "string" &&
			typeof (d as Record<string, unknown>).scope === "string",
	};
	const check = need[type];
	if (check && !check(data)) throw new Error(`bad data shape for ${type}`);
}

/** Optional spool writer for one declared producer, or null when inert (no fleet state). */
export function ccSpool(producer: string, opts: CcSpoolOptions = {}): CcSpool | null {
	if (process.env.OMP_KIT_CC === "0") return null;
	if (!(producer in PRODUCER_OWNERS) || producer.includes("/") || producer === "." || producer === "..") {
		throw new Error("PRODUCER_UNDECLARED_OR_UNSAFE");
	}
	const stateDir = opts.stateDir ?? defaultStateDir();
	const clock = opts.clock ?? Date.now;
	let spoolDir: string;
	let producerDir: string;
	try {
		if (!statSync(stateDir).isDirectory()) return null;
		spoolDir = join(stateDir, "spool");
		if (!existsSync(spoolDir) || !statSync(spoolDir).isDirectory()) return null;
		checkNoSymlink(spoolDir);
		producerDir = join(spoolDir, producer);
	} catch {
		return null;
	}

	const adapter: CcSpool = {
		producer,
		failures: 0,
		envelope(type: string, data: Record<string, unknown>, envOpts: EnvelopeOptions): Record<string, unknown> {
			if (!(type in TYPE_VERSIONS)) throw new Error(`TYPE_UNDECLARED: ${type}`);
			if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("DATA_NOT_OBJECT");
			checkDataShape(type, data);
			const observed = envOpts.observedMs ?? clock();
			const env: Record<string, unknown> = {
				specversion: SPEC_VERSION,
				id: makeId(producer, envOpts.key, type),
				position: envOpts.key,
				source: envOpts.source || producer,
				type,
				time: isoMs(envOpts.timeMs),
				observed: isoMs(observed),
				producer,
				dataschema: `${type}@${TYPE_VERSIONS[type]}`,
				confidence: envOpts.confidence ?? "exact",
				data,
			};
			if (envOpts.ctx) {
				for (const [k, v] of Object.entries(envOpts.ctx)) {
					if (v !== null && v !== undefined) env[k] = v;
				}
			}
			canonical(env);
			return env;
		},
		append(envs: Array<Record<string, unknown>>): number {
			try {
				if (envs.length === 0) return 0;
				const lines: string[] = [];
				for (const env of envs) {
					let line = canonical(env);
					if (looksSecret(line)) {
						const t = clock();
						const position = `redaction:${String(env.id ?? "")}`;
						line = canonical({
							specversion: SPEC_VERSION,
							id: makeId(producer, position, "cc.unknown"),
							position,
							source: producer,
							type: "cc.unknown",
							time: isoMs(t),
							observed: isoMs(t),
							producer,
							dataschema: "cc.unknown@1",
							confidence: "exact",
							data: {
								class: "U-redaction",
								scope: `producer:${producer}`,
								action: "raise",
								owner: PRODUCER_OWNERS[producer],
								route: REDACTION_ROUTE,
								detail: "CREDENTIAL_SHAPE_AT_PRODUCER",
								cost_seat_ms: null,
								cost_bound: null,
							},
						});
					}
					lines.push(line);
				}
				const day = isoMs(clock()).slice(0, 10);
				mkdirSync(producerDir, { recursive: true });
				checkNoSymlink(spoolDir, producerDir);
				let newest = day;
				for (const name of readdirSync(producerDir)) {
					if (DAY_FILE.test(name) && name.slice(0, 10) > newest) newest = name.slice(0, 10);
				}
				const path = join(producerDir, `${newest}.jsonl`);
				let lead = "";
				try {
					const st = statSync(path);
					if (st.size > 0) {
						checkNoSymlink(path);
						const fd = openSync(path, "r");
						try {
							const buf = Buffer.alloc(1);
							readSync(fd, buf, 0, 1, st.size - 1);
							if (buf[0] !== 0x0a) lead = "\n";
						} finally {
							closeSync(fd);
						}
					}
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
				const payload = lead + lines.join("\n") + "\n";
				const fd = openSync(path, "a");
				try {
					writeSync(fd, payload, null, "utf8");
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
				return lines.length;
			} catch {
				adapter.failures += 1;
				return 0;
			}
		},
	};
	return adapter;
}

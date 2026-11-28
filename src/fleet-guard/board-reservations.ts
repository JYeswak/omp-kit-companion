// File reservations on Board tasks (bead ompkit-tnqyr.3): the only reservation backend.
// One task per path glob in channel res/<project>, labelled {path, holder, exclusive},
// claimed with a lease. reserve = create+claim, renew = task renew, release = complete,
// conflicts = open claimed tasks whose glob overlaps (matched here, not on the Board).
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isLoopbackBoardUrl, kitBoardLocalDir } from "../board-events.ts";
import { reservationPatternCovers } from "./reservations.ts";

const LEASE_MIN_S = 30;
const LEASE_MAX_S = 3600;
const LABEL_MAX = 200;

/** Two globs overlap when either covers the other (same function the Agent Mail guard uses). */
export function globsOverlap(a: string, b: string): boolean {
	return reservationPatternCovers(a, b) || reservationPatternCovers(b, a);
}

export function boardProfile(name: string): string {
	let s = String(name || "unknown").replace(/[^A-Za-z0-9-]/g, "-").replace(/^[^A-Za-z]+/, "");
	if (!s) s = "agent";
	return s.slice(0, 32);
}

export function boardChannel(project: string): string {
	let s = String(project).toLowerCase();
	if (s.startsWith("/")) s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (s.startsWith("users-josh-developer-") && s.length > 21) s = s.slice(21);
	return "res/" + (s.replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "") || "project");
}

export interface BoardResConfig {
	url?: string;
	token?: string;
	/** Directory holding claim tokens and the last-good snapshot. */
	stateDir?: string;
	fetch?: typeof fetch;
	now?: () => number;
	/** Overlap predicate; production uses globsOverlap. A test seam for the planted negative. */
	overlaps?: (a: string, b: string) => boolean;
}

export interface Hold { id: string; path: string; holder: string; exclusive: boolean; until: number }
export interface Grant { granted: Hold[]; conflicts: Hold[] }
interface Token { epoch: number; token: string }

function readToken(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	const dir = xdg === undefined ? kitBoardLocalDir(homedir()) : join(xdg, "board", "local");
	const file = readdirSync(dir).filter((n) => n.endsWith(".json")).sort()[0];
	if (!file) throw new Error("no Board credential under " + dir);
	const credential = JSON.parse(readFileSync(join(dir, file), "utf8"));
	// Older local credential files are token-only; validate any URL the file actually supplies.
	if (credential.url !== undefined && (typeof credential.url !== "string" || !isLoopbackBoardUrl(credential.url)))
		throw new Error("Board credential does not name a loopback HTTP(S) URL");
	return credential.token;
}

export class BoardReservations {
	private readonly url: string;
	private readonly stateDir: string;
	private readonly doFetch: typeof fetch;
	private readonly now: () => number;
	private readonly overlaps: (a: string, b: string) => boolean;
	private readonly tokenOverride: string | undefined;

	constructor(cfg: BoardResConfig = {}) {
		this.url = (cfg.url ?? process.env.BOARD_URL ?? "http://127.0.0.1:4178/api/board").replace(/\/$/, "");
		this.stateDir = cfg.stateDir ?? process.env.FLEET_BOARD_RES_STATE ?? join(homedir(), ".local/share/omp-kit/board-res");
		this.doFetch = cfg.fetch ?? fetch;
		this.now = cfg.now ?? Date.now;
		this.overlaps = cfg.overlaps ?? globsOverlap;
		this.tokenOverride = cfg.token;
	}

	private async api(method: string, path: string, profile: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; body: any }> {
		const target = this.url + path;
		if (!isLoopbackBoardUrl(target)) throw new Error("Board reservations require a loopback HTTP(S) URL");
		const url = new URL(target);
		for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
		const headers: Record<string, string> = { authorization: "Bearer " + (this.tokenOverride ?? readToken()), "x-board-profile": profile };
		if (body !== undefined) headers["content-type"] = "application/json";
		const r = await this.doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
		const text = await r.text();
		let json: any;
		try { json = JSON.parse(text); } catch { json = text; }
		return { status: r.status, body: json };
	}

	private tokensPath(profile: string): string { return join(this.stateDir, profile + ".tokens.json"); }
	private snapshotPath(channel: string): string { return join(this.stateDir, channel.replace(/\//g, "_") + ".lastgood.json"); }
	private readJson<T>(path: string, dflt: T): T {
		try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return dflt; }
	}
	private writeJson(path: string, value: unknown): void {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = path + "." + process.pid + ".tmp";
		writeFileSync(tmp, JSON.stringify(value));
		renameSync(tmp, path);
	}
	private saveToken(profile: string, id: string, t: Token | undefined): void {
		const all = this.readJson<Record<string, Token>>(this.tokensPath(profile), {});
		if (t) all[id] = t;
		else delete all[id];
		this.writeJson(this.tokensPath(profile), all);
	}

	/** Open claimed holds in the project channel (lease unexpired). Throws when the Board is unreachable. */
	async listOpen(project: string): Promise<Hold[]> {
		const channel = boardChannel(project);
		const r = await this.api("GET", "/tasks", "reservations", undefined, { channel, state: "claimed", limit: "500" });
		if (r.status !== 200 || !Array.isArray(r.body?.tasks)) throw new Error("Board tasks HTTP " + r.status);
		const nowMs = this.now();
		const holds: Hold[] = [];
		for (const t of r.body.tasks) {
			const m = t.message ?? t;
			const labels = m.labels ?? {};
			const until = Date.parse(m.task?.claim?.until ?? t.task?.claim?.until ?? "");
			if (typeof labels.path !== "string" || !(until > nowMs)) continue;
			holds.push({ id: String(m.id), path: labels.path, holder: String(labels.holder ?? ""), exclusive: labels.exclusive !== "0", until });
		}
		this.writeJson(this.snapshotPath(channel), { at: nowMs, holds });
		return holds;
	}

	private conflictsFor(holds: readonly Hold[], holder: string, path: string): Hold[] {
		return holds.filter((h) => h.holder !== holder && h.exclusive && this.overlaps(h.path, path));
	}

	/**
	 * Reserve exclusive paths. Race-safe without a Board transaction: check, create+claim,
	 * then re-list; of overlapping exclusive holds the lowest task id keeps it, the others
	 * release and are refused. Both racers see each other after their own create, so one wins.
	 */
	async reserve(project: string, holder: string, paths: readonly string[], ttlS = 3600, reason = ""): Promise<Grant> {
		const channel = boardChannel(project);
		const profile = boardProfile(holder);
		const lease = Math.min(LEASE_MAX_S, Math.max(LEASE_MIN_S, Math.ceil(ttlS)));
		const granted: Hold[] = [];
		const refused: Hold[] = [];
		for (const path of paths) {
			const early = this.conflictsFor(await this.listOpen(project), holder, path);
			if (early.length) { refused.push(...early); continue; }
			const labels = { path: path.slice(0, LABEL_MAX), holder: holder.slice(0, LABEL_MAX), exclusive: "1" };
			const text = ("reserve " + path + (reason ? "\n\n" + reason : "")).slice(0, 10000);
			const r = await this.api("POST", "/tasks", profile, { channel, text, labels, claim: true, lease });
			if (r.status !== 201 || !r.body?.claim) throw new Error("Board reserve HTTP " + r.status);
			const id = String(r.body.task.id ?? r.body.task.message?.id);
			const tok: Token = { epoch: r.body.claim.epoch, token: r.body.claim.token };
			this.saveToken(profile, id, tok);
			const mine: Hold = { id, path, holder, exclusive: true, until: Date.parse(r.body.claim.until) };
			const after = this.conflictsFor(await this.listOpen(project), holder, path);
			const beaten = after.filter((h) => BigInt(h.id) < BigInt(id));
			if (beaten.length) {
				await this.api("POST", "/tasks/" + id + "/complete", profile, { ...tok, result: "lost race" });
				this.saveToken(profile, id, undefined);
				refused.push(...beaten);
				continue;
			}
			granted.push(mine);
		}
		return { granted, conflicts: refused };
	}

	/** Extend leases of the holder's open holds (all, or those whose glob overlaps `paths`). */
	async renew(project: string, holder: string, paths: readonly string[] = [], extendS = 1800): Promise<Hold[]> {
		const profile = boardProfile(holder);
		const tokens = this.readJson<Record<string, Token>>(this.tokensPath(profile), {});
		const lease = Math.min(LEASE_MAX_S, Math.max(LEASE_MIN_S, Math.ceil(extendS)));
		const renewed: Hold[] = [];
		for (const h of await this.listOpen(project)) {
			if (h.holder !== holder) continue;
			if (paths.length && !paths.some((p) => this.overlaps(h.path, p))) continue;
			const tok = tokens[h.id];
			if (!tok) continue;
			const r = await this.api("POST", "/tasks/" + h.id + "/renew", profile, { ...tok, lease });
			if (r.status === 200) renewed.push({ ...h, until: r.body?.until ? Date.parse(r.body.until) : this.now() + lease * 1000 });
		}
		return renewed;
	}

	/** Release (complete) the holder's holds, all or those overlapping `paths`. */
	async release(project: string, holder: string, paths: readonly string[] = []): Promise<number> {
		const profile = boardProfile(holder);
		const tokens = this.readJson<Record<string, Token>>(this.tokensPath(profile), {});
		let n = 0;
		for (const h of await this.listOpen(project)) {
			if (h.holder !== holder) continue;
			if (paths.length && !paths.some((p) => this.overlaps(h.path, p))) continue;
			const tok = tokens[h.id];
			if (!tok) continue;
			const r = await this.api("POST", "/tasks/" + h.id + "/complete", profile, { ...tok, result: "released" });
			if (r.status === 200) { this.saveToken(profile, h.id, undefined); n++; }
		}
		return n;
	}

	/** Seconds since the last-good snapshot of the project channel was written; null when none exists. */
	snapshotAgeS(project: string): number | null {
		const snap = this.readJson<{ at?: number }>(this.snapshotPath(boardChannel(project)), {});
		return typeof snap.at === "number" ? Math.max(0, Math.round((this.now() - snap.at) / 1000)) : null;
	}

	/**
	 * Attested read: the Board answered GET /me 200 and the res/<project> listing succeeded.
	 * Throws otherwise; callers fail closed and may cite snapshotAgeS (the snapshot never admits).
	 */
	async attestedOpen(project: string): Promise<Hold[]> {
		const me = await this.api("GET", "/me", "reservations");
		if (me.status !== 200) throw new Error("Board /me HTTP " + me.status);
		return this.listOpen(project);
	}

	/**
	 * Hook lookup. Board down -> judge from the last-good snapshot (unexpired leases only);
	 * no snapshot -> not covered, so the edit is refused (fail closed).
	 */
	async check(project: string, holder: string, path: string): Promise<{ covered: boolean; conflicts: Hold[] }> {
		let holds: Hold[];
		try {
			holds = await this.listOpen(project);
		} catch {
			const snap = this.readJson<{ holds?: Hold[] }>(this.snapshotPath(boardChannel(project)), {});
			const nowMs = this.now();
			holds = (snap.holds ?? []).filter((h) => h.until > nowMs);
		}
		const covered = holds.some((h) => h.holder === holder && h.exclusive && reservationPatternCovers(h.path, path));
		return { covered, conflicts: this.conflictsFor(holds, holder, path) };
	}
}

let shared: BoardReservations | undefined;
export function boardLookup(input: { projectKey: string; agentName: string; path: string }): Promise<{ covered: boolean; conflicts: readonly unknown[] }> {
	shared ??= new BoardReservations();
	return shared.check(input.projectKey, input.agentName, input.path);
}

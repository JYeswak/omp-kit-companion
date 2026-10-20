/** fleet-user-config.ts — operator fleet overlay shared by lessons and planning score.
 *
 * Shipped config holds no fleet literals (oq1h.7): the fleet list lives in the
 * operator's user config (or private overlay), resolved here. Absent file means
 * unconfigured (stock runner); a present-but-invalid file fails closed.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface UserFleetRepo {
	name: string;
	path: string;
	tracker: string | null;
}

/** User fleet overlay path: explicit override, then XDG config, then ~/.config. Never inside the kit root. */
export function userFleetConfigPath(home: string): string {
	const override = process.env.OMP_KIT_FLEET_CONFIG;
	if (override !== undefined && override !== "") return override;
	const base = process.env.XDG_CONFIG_HOME;
	const dir = base !== undefined && base !== "" && isAbsolute(base) ? base : join(home, ".config");
	return join(dir, "omp-kit", "fleet.toml");
}

function configuredUserPath(value: unknown, home: string, kitRoot: string, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`LESSONS_CONFIG_${name.toUpperCase()}_INVALID`);
	const raw = value.trim();
	const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : isAbsolute(raw) ? raw : resolve(kitRoot, raw);
	if (!isAbsolute(expanded) || resolve(expanded) !== expanded) throw new Error(`LESSONS_CONFIG_${name.toUpperCase()}_INVALID`);
	return expanded;
}

export function parseUserFleetRepos(reposValue: unknown[], home: string, kitRoot: string): UserFleetRepo[] {
	const names = new Set<string>(), paths = new Set<string>();
	return reposValue.map((value, index) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`LESSONS_CONFIG_REPO_${index}_INVALID`);
		const row = value as Record<string, unknown>;
		if (typeof row.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.name)) throw new Error(`LESSONS_CONFIG_REPO_${index}_NAME_INVALID`);
		if (names.has(row.name)) throw new Error(`LESSONS_CONFIG_REPO_NAME_DUPLICATE:${row.name}`);
		const path = configuredUserPath(row.path, home, kitRoot, `repo_${row.name}`);
		if (paths.has(path)) throw new Error(`LESSONS_CONFIG_REPO_PATH_DUPLICATE:${path}`);
		names.add(row.name);
		paths.add(path);
		return { name: row.name, path, tracker: row.tracker === undefined || row.tracker === null ? null : configuredUserPath(row.tracker, home, kitRoot, `tracker_${row.name}`) };
	});
}

/** Raw user overlay: validated repo rows plus unparsed fleet/classifier sections for caller-owned merging. */
export function readUserFleetFile(home: string): { fleet: Record<string, unknown>; classifier?: Record<string, unknown> } | null {
	const path = userFleetConfigPath(home);
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw new Error("LESSONS_CONFIG_USER_FLEET_UNREADABLE");
	}
	let parsed: unknown;
	try { parsed = Bun.TOML.parse(text); }
	catch { throw new Error("LESSONS_CONFIG_USER_FLEET_INVALID_TOML"); }
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("LESSONS_CONFIG_USER_FLEET_INVALID_TOML");
	const root = parsed as Record<string, unknown>;
	const fleetRaw = root.fleet ?? {};
	if (fleetRaw === null || typeof fleetRaw !== "object" || Array.isArray(fleetRaw)) throw new Error("LESSONS_CONFIG_USER_FLEET_INVALID");
	const classifierRaw = root.classifier;
	if (classifierRaw !== undefined && (classifierRaw === null || typeof classifierRaw !== "object" || Array.isArray(classifierRaw)))
		throw new Error("LESSONS_CONFIG_CLASSIFIER_INVALID");
	return { fleet: fleetRaw as Record<string, unknown>, ...(classifierRaw === undefined ? {} : { classifier: classifierRaw as Record<string, unknown> }) };
}

/** Validated user repo rows, or [] when no overlay file exists. */
export function readUserFleetRepos(home: string, kitRoot: string): UserFleetRepo[] {
	const file = readUserFleetFile(home);
	if (!file) return [];
	const reposRaw = file.fleet.repos ?? [];
	if (!Array.isArray(reposRaw)) throw new Error("LESSONS_CONFIG_REPOS_INVALID");
	return parseUserFleetRepos(reposRaw, home, kitRoot);
}

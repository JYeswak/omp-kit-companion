/**
 * kit-guard-optin: per-repo opt-in loader for an externally supplied config-driven guard.
 *
 * A repo opts in by committing `.omp/kit-guard.json` at its root (the nearest ancestor holding
 * `.git`). The external guard owns the config schema.
 *   - no config at the root: nothing is registered;
 *   - the repo ships `.omp/extensions/kit-guard/`: nothing is registered, because omp loads that
 *     copy itself and a second copy would double every block;
 *   - opted in: the guard is imported from explicit KIT_GUARD_SRC and handed this extension's API;
 *   - opted in without KIT_GUARD_SRC or when the guard does not load: every tool call is blocked.
 *     The repo asked for the gate; running without it is the unsafe direction.
 * The decision is made once, at extension load, for the directory omp started in.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The slice of omp's ExtensionAPI this loader touches; the guard receives the whole object. */
interface ExtensionApiSlice {
	setLabel(label: string): void;
	on(event: "tool_call", handler: () => Promise<{ block: true; reason: string }>): void;
}

export const CONFIG_REL_PATH = ".omp/kit-guard.json";
export const PROJECT_COPY_REL_PATH = ".omp/extensions/kit-guard";

export type OptInState =
	| { kind: "off"; root: string }
	| { kind: "project-copy"; root: string }
	| { kind: "on"; root: string; src: string | undefined };

/** Nearest ancestor of `start` holding `.git`; `start` itself when there is none. */
export function projectRoot(start: string): string {
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return start;
	}
}

export function optInState(cwd: string, guardSrc: string | undefined): OptInState {
	const root = projectRoot(cwd);
	if (!existsSync(join(root, CONFIG_REL_PATH))) return { kind: "off", root };
	if (existsSync(join(root, PROJECT_COPY_REL_PATH))) return { kind: "project-copy", root };
	return { kind: "on", root, src: guardSrc || undefined };
}

export default async function kitGuardOptIn(pi: ExtensionApiSlice): Promise<void> {
	const state = optInState(process.cwd(), process.env.KIT_GUARD_SRC);
	if (state.kind !== "on") return;
	try {
		if (!state.src) throw new Error("KIT_GUARD_SRC is unset; set it to the guard entrypoint");
		const mod: unknown = await import(state.src);
		const factory = mod && typeof mod === "object" && "default" in mod ? mod.default : undefined;
		if (typeof factory !== "function") throw new Error(`${state.src} has no default-exported function`);
		await factory(pi);
	} catch (err) {
		const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
		const reason =
			`kit-guard-optin: ${state.root} opts in (${CONFIG_REL_PATH}) but the guard ` +
			`${state.src ? `at ${state.src}` : "source KIT_GUARD_SRC"} did not load: ${why}. ` +
			"Every tool call is refused (fail-closed) until the guard loads; set KIT_GUARD_SRC to a working guard entrypoint.";
		pi.setLabel("kit-guard-optin");
		pi.on("tool_call", async () => ({ block: true, reason }));
	}
}

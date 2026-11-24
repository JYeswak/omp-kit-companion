/**
 * TCCPROMPT1 (ompkit-7pfj1 box [b]): the omp start probe the `kit update --apply`
 * path and the `kit-update` job run before the plugin link moves or any update
 * notice goes out.
 *
 * On 2026-11-21 an unanswered macOS consent prompt made every new omp start hang,
 * while kit updates kept moving plugin links and emitting UPGRADE_NOTICE into seats
 * that could not start. The probe runs `omp -p "Reply ok." --no-session --model
 * omp-kit-start-probe/none` (stdin closed, no TTY): omp goes through its whole
 * startup (plugin roots, settings, model registry) and then refuses the model that
 * does not exist, so it exits by itself in about 2 s (measured on omp 19.1.0 with
 * PI_DEBUG_STARTUP: 276 startup lines, preloadPluginRoots done, exit 1) without a
 * model call, a credential or the network. A start that hangs in startup, the
 * incident, never exits: kitlib's bounded run kills the whole process group on the
 * deadline. Only a probe that does not finish inside the deadline holds the update:
 * a start that exits (zero or not) is a healthy start, and an unspawnable omp is
 * unprobeable, so both let the update proceed. It probes the current environment,
 * not a not-yet-linked release: omp loads its plugins from the live per-profile
 * links and no flag points a start at a pending store, so a start that hangs on the
 * machine is the incident this refuses.
 */
import { cpus, loadavg } from "node:os";
import { run } from "./kitlib/run.ts";

/** Wall-clock bound for the probe; tests shorten it with OMP_KIT_START_PROBE_DEADLINE_S. */
export const START_PROBE_DEFAULT_DEADLINE_S = 45;
export const START_PROBE_DEADLINE_ENV = "OMP_KIT_START_PROBE_DEADLINE_S";
/** The envelope keeps only the end of the probe's combined output. */
export const START_PROBE_MAX_TAIL = 2000;
/** A model name no omp resolves, so the probe stops after startup instead of calling a model. */
export const START_PROBE_MODEL = "omp-kit-start-probe/none";

export interface StartProbeResult {
	/** The probe process spawned. False means unprobeable (no omp on PATH, unexecutable binary): never a hang, never a hold. */
	started: boolean;
	/** The probe did not finish inside the deadline: the hang class this gate holds. */
	timedOut: boolean;
	exit: number | null;
	tail: string;
}

/**
 * PENDINGSTUCK1 (ompkit-hhqsz): omp started in 6 s on a hand rerun a minute after a 45 s probe held the 0.2.147 update at load ~28.
 * The default deadline therefore grows with the host's load per CPU, up to START_PROBE_MAX_LOAD_FACTOR times; a start that hangs
 * (the consent-prompt incident) never exits, so a longer bound only delays that hold. An explicit env deadline is used as given.
 */
export const START_PROBE_MAX_LOAD_FACTOR = 4;

export interface StartProbeOptions {
	/** One-minute load average and CPU count the deadline scales by; default the host's. */
	load1?: number;
	cpus?: number;
	/** The unscaled deadline when the env override is unset; default START_PROBE_DEFAULT_DEADLINE_S (tests shorten it). */
	baseDeadlineS?: number;
}

export function startProbeLoadFactor(load1: number, cpus: number): number {
	const ratio = cpus > 0 ? load1 / cpus : 1;
	return Number.isFinite(ratio) ? Math.min(START_PROBE_MAX_LOAD_FACTOR, Math.max(1, ratio)) : 1;
}

/** Only a hang holds: a start that exits (zero or not) inside the deadline, or an unspawnable omp, lets the update proceed. */
export async function runStartProbe(options: StartProbeOptions = {}): Promise<StartProbeResult> {
	const raw = (process.env[START_PROBE_DEADLINE_ENV] ?? "").trim();
	const parsed = raw === "" ? options.baseDeadlineS ?? START_PROBE_DEFAULT_DEADLINE_S : Number(raw);
	const base = Number.isFinite(parsed) && parsed > 0 ? parsed : START_PROBE_DEFAULT_DEADLINE_S;
	const deadline = raw === "" ? base * startProbeLoadFactor(options.load1 ?? loadavg()[0] ?? 0, options.cpus ?? cpus().length) : base;
	// Snapshot the environment explicitly: Bun resolves the binary against the env the
	// spawn call carries, not later in-process PATH edits, so inherit exactly what this
	// process sees (a test fake placed first on PATH included).
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	try {
		const result = await run(["omp", "-p", "Reply ok.", "--no-session", "--model", START_PROBE_MODEL], { deadline_s: deadline, env });
		const tail = (new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).slice(-START_PROBE_MAX_TAIL);
		return { started: true, timedOut: result.timed_out, exit: result.rc, tail };
	} catch (error) {
		return { started: false, timedOut: false, exit: null, tail: String(error instanceof Error ? error.message : error).slice(-START_PROBE_MAX_TAIL) };
	}
}

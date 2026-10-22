import { expect, test } from "bun:test";
import {
	buildEeAmbientArgv,
	createEeAmbientSessionStartAdapter,
	resolveAmbientSettings,
	type EeRunResult,
} from "../../extensions/ee-ambient-session-start.ts";

/** Largest ee orient estimate observed in the fleet (ompkit-fp72.15): 11059 tokens. */
const OBSERVED_CEILING = 11_059;

const context = {
	cwd: "/tmp/ee-orient-budget-test", // tempsafe: fake cwd value in fixture, nothing created
	sessionManager: { getSessionId: () => "budget-probe" },
};

const store = () => ({ read: async () => undefined, write: async () => {} });

test("default orient budget fits the observed ee payload ceiling", () => {
	const settings = resolveAmbientSettings({});
	expect(settings.budget).toBeGreaterThanOrEqual(OBSERVED_CEILING);
	const argv = buildEeAmbientArgv(settings);
	expect(argv.slice(0, 3)).toEqual([argv[0], "--max-output-tokens", String(settings.budget)]);
});

test("forcing the old 1200 budget reproduces the withheld payload", async () => {
	const messages: string[] = [];
	const adapter = createEeAmbientSessionStartAdapter({
		env: { EE_AMBIENT_CONTEXT_BUDGET: "1200" },
		runEe: async (): Promise<EeRunResult> => ({
			exitCode: 1,
			stdout: "",
			stderr: "Output budget unsatisfiable: estimated 11059 tokens against a ceiling of 1200",
			timedOut: false,
		}),
		sink: (message) => messages.push(message),
		stateStore: store(),
	});
	await adapter.handle({ type: "session_start" }, context);
	expect(messages).toEqual([]);
});

test("orient advisory is delivered within the raised budget", async () => {
	const messages: string[] = [];
	const seen: string[][] = [];
	const adapter = createEeAmbientSessionStartAdapter({
		env: {},
		runEe: async (argv): Promise<EeRunResult> => {
			seen.push(argv);
			return { exitCode: 0, stdout: '{"orient":"ok"}', stderr: "", timedOut: false };
		},
		sink: (message) => messages.push(message),
		stateStore: store(),
	});
	await adapter.handle({ type: "session_start" }, context);
	expect(messages.length).toBe(1);
	expect(messages[0]).toContain("ee ambient_context");
	expect(messages[0]).toContain(`budgetTokens=${resolveAmbientSettings({}).budget}`);
	expect(Number(seen[0]?.[2])).toBeGreaterThanOrEqual(OBSERVED_CEILING);
});

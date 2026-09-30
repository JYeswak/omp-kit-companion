import { createInterface } from "node:readline";
import { isatty } from "node:tty";

export type PresentationResult = {
	code: 0 | 1 | 2 | 3 | 4;
	data: Record<string, unknown>;
	errors?: readonly { code: string; message: string; remediation: string }[];
	warnings?: readonly string[];
	commands?: readonly string[];
	verification?: "PERFORMED" | "NOT_RUN" | "UNVERIFIED";
};

export type PresentationOptions = { toolVersion: string; schemaVersion: string; json: boolean };

/** Locale-independent ordering for serialized facts and authored witness identifiers. */
export function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function stableData(value: unknown, key = ""): unknown {
	if (Array.isArray(value)) {
		const entries = value.map((entry) => stableData(entry));
		return key === "findings"
			? entries.sort((left, right) => {
				const leftComponent = left !== null && typeof left === "object" && "component" in left ? String(left.component) : "";
				const rightComponent = right !== null && typeof right === "object" && "component" in right ? String(right.component) : "";
				return compare(leftComponent, rightComponent);
			})
			: entries;
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compare(left, right)).map(([name, entry]) => [name, stableData(entry, name)]));
	}
	return value;
}

/** Pure: the caller writes stdout and stderr separately and uses exitCode unchanged. */
export function renderOutput(result: PresentationResult, options: PresentationOptions): { stdout: string; stderr: string; exitCode: PresentationResult["code"] } {
	const errors = [...(result.errors ?? [])].sort((left, right) => compare(left.code, right.code) || compare(left.message, right.message) || compare(left.remediation, right.remediation));
	if (options.json) {
		const envelope = {
			ok: result.code === 0,
			tool_version: options.toolVersion,
			data: stableData(result.data),
			meta: { schema_version: options.schemaVersion, verification: result.verification ?? "NOT_RUN" },
			warnings: result.warnings ?? [],
			commands: result.commands ?? [],
			errors,
		};
		return { stdout: `${JSON.stringify(envelope)}\n`, stderr: "", exitCode: result.code };
	}
	const diagnostics = [
		...(result.warnings ?? []),
		...errors.map((error) => `${error.code}: ${error.message}\n${error.remediation}`),
	];
	const stderr = diagnostics.length ? `${diagnostics.join("\n")}\n` : "";
	if (errors.length) return { stdout: "", stderr, exitCode: result.code };
	const data = typeof result.data.text === "string" ? result.data.text : JSON.stringify(stableData(result.data), null, 2);
	return { stdout: `${data.endsWith("\n") ? data : `${data}\n`}`, stderr, exitCode: result.code };
}

type TerminalInput = NodeJS.ReadableStream & { isTTY?: boolean; fd?: number; readableEnded?: boolean; destroyed?: boolean };
type TerminalOutput = NodeJS.WritableStream & { isTTY?: boolean; fd?: number };

export type MutationConsent = {
	action: string;
	/** Only an explicitly requested mutation can reach a handler, including with --yes. */
	explicit: boolean;
	yes: boolean;
	json: boolean;
	robot: boolean;
	noColor: boolean;
	env?: NodeJS.ProcessEnv;
	stdin?: TerminalInput;
	stdout?: TerminalOutput;
	stderr?: TerminalOutput;
};

function realTerminal(stream: TerminalInput | TerminalOutput): boolean {
	return stream.isTTY === true && typeof stream.fd === "number" && isatty(stream.fd);
}

/** Call before dispatching an explicit mutation; false means refuse without invoking the handler. */
export async function confirmMutation(options: MutationConsent): Promise<boolean> {
	if (!options.explicit) return false;
	if (options.yes) return true;
	const env = options.env ?? process.env;
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	if (options.json || options.robot || options.noColor || Object.hasOwn(env, "NO_COLOR") || Object.hasOwn(env, "CI") || env.TERM === "dumb"
		|| !realTerminal(stdin) || !realTerminal(stdout) || !realTerminal(stderr) || stdin.readableEnded || stdin.destroyed) return false;

	const question = createInterface({ input: stdin, terminal: false });
	const action = options.action.replace(/[\r\n\u001b]/g, " ");
	return await new Promise<boolean>((resolve) => {
		let settled = false;
		function finish(confirmed: boolean): void {
			if (settled) return;
			settled = true;
			question.close();
			resolve(confirmed);
		}
		question.once("line", (line) => finish(line.trim() === "CONFIRM"));
		question.once("close", () => finish(false));
		stderr.write(`Confirm ${action}: type CONFIRM to proceed: `);
	});
}

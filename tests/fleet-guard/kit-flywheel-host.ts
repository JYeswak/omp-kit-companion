import { join } from "node:path";
import kitFlywheelGuard, {
 type FlywheelContext,
 type FlywheelExecOptions,
 type FlywheelExecResult,
 type FlywheelMessage,
 type FlywheelToolCallEvent,
 type FlywheelToolCallResult,
} from "../../extensions/kit-flywheel-guard";

export interface FakeHost {
 emit(type: string, event: Record<string, unknown>, ctx: FlywheelContext): Promise<unknown[]>;
 ctx(cwd: string, idle?: boolean): FlywheelContext;
 sent: { message: FlywheelMessage; options?: { deliverAs?: string } }[];
 execs: ExecCall[];
 notices: string[];
}

export interface ExecCall { command: string; args: string[]; options?: FlywheelExecOptions }
export type Responder = (call: ExecCall) => FlywheelExecResult | Promise<FlywheelExecResult>;
type SessionStartHandler = (event: { type: "session_start" }, ctx: FlywheelContext) => unknown;
type CompactHandler = (event: { type: "session_compact" }, ctx: FlywheelContext) => unknown;
type ToolHandler = (event: FlywheelToolCallEvent, ctx: FlywheelContext) => unknown;
type EndHandler = (event: Record<string, unknown>, ctx: FlywheelContext) => unknown;
type HostRegistration = ["session_start", SessionStartHandler] | ["session_compact", CompactHandler] | ["tool_call", ToolHandler] | ["tool_execution_end", EndHandler];
/** Fake omp host: records handlers, sent messages and every exec the guard makes. */
export async function createFlywheelHost(base: string, opts: { env?: Record<string, string | undefined>; home?: string; respond?: Responder } = {}): Promise<FakeHost> {
	const starts: SessionStartHandler[] = [];
	const compacts: CompactHandler[] = [];
	const tools: ToolHandler[] = [];
	const ends: EndHandler[] = [];
	const sent: FakeHost["sent"] = [];
	const execs: ExecCall[] = [];
	const notices: string[] = [];
	const respond: Responder = opts.respond ?? (() => ({ stdout: "", stderr: "not stubbed", code: 127 }));
	const pi = {
		on: (...args: HostRegistration) => {
		if (args[0] === "session_start") {
			starts.push(args[1]);
			return;
		}
		if (args[0] === "session_compact") compacts.push(args[1]);
		else if (args[0] === "tool_execution_end") ends.push(args[1]);
		else tools.push(args[1]);
		},
		sendMessage: (message: FlywheelMessage, options?: { deliverAs?: string }) => void sent.push({ message, options }),
		exec: async (command: string, args: string[], options?: FlywheelExecOptions) => {
			const call = { command, args, options };
			execs.push(call);
			return respond(call);
		},
	};
	await kitFlywheelGuard(pi, { env: opts.env ?? {}, home: opts.home ?? join(base, "no-home") });
	const emit = async (type: string, event: Record<string, unknown>, ctx: FlywheelContext): Promise<unknown[]> => {
		const results: unknown[] = [];
		if (type === "session_start") {
			for (const handler of starts) results.push(await handler({ type: "session_start" }, ctx));
		} else if (type === "session_compact") {
			for (const handler of compacts) results.push(await handler({ type: "session_compact" }, ctx));
		} else if (type === "tool_call") {
			for (const handler of tools) results.push(await handler({ ...event, type: "tool_call" }, ctx));
		} else if (type === "tool_execution_end") {
			for (const handler of ends) results.push(await handler({ ...event, type: "tool_execution_end" }, ctx));
		}
		return results;
	};
	const ctx = (cwd: string, idle = true): FlywheelContext =>
		({ cwd, isIdle: () => idle, ui: { notify: (message: string) => void notices.push(message) } });
	return { emit, ctx, sent, execs, notices };
}

export async function toolCall(h: FakeHost, cwd: string, command: string): Promise<FlywheelToolCallResult | undefined> {
	const [result] = await h.emit("tool_call", { toolCallId: "c1", toolName: "bash", input: { command } }, h.ctx(cwd));
	return result as FlywheelToolCallResult | undefined;
}

export async function bashInput(h: FakeHost, input: Record<string, unknown>): Promise<FlywheelToolCallResult | undefined> {
	const [result] = await h.emit("tool_call", { toolCallId: "c1", toolName: "bash", input }, h.ctx("/repo"));
	return result as FlywheelToolCallResult | undefined;
}

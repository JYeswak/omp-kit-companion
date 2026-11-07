import { subscribeReleaseVerdicts } from "../src/release-verdict-mail.ts";

/** NATIVESESSION1: Tern owns process persistence; OMP owns goal continuation and pause.
 * This observer only registers external verdict delivery. It never starts a turn,
 * creates a goal, resumes a paused goal, or schedules a wake. */
export interface GoalKeepaliveContext {
	cwd?: string;
	sessionManager?: { getBranch?: () => readonly { type?: string; customType?: string; data?: { phases?: unknown }; message?: { role?: string; toolName?: string; isError?: boolean; details?: { phases?: unknown } } }[] };
}
export interface GoalKeepaliveApi {
	on(event: string, handler: (event: never, ctx: GoalKeepaliveContext) => unknown): void;
}
export function seatIdentity(env: Record<string, string | undefined>): string | null {
	for (const key of ["BR_ACTOR", "BR_AGENT_NAME", "AGENT_NAME"]) {
		const value = env[key]?.trim();
		if (value) return value;
	}
	return null;
}
function blockedEvents(ctx: GoalKeepaliveContext): string[] {
	const entries = ctx.sessionManager?.getBranch?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		const phases = entry.type === "custom" && entry.customType === "user_todo_edit" ? entry.data?.phases
			: entry.message?.role === "toolResult" && entry.message.toolName === "todo" && !entry.message.isError ? entry.message.details?.phases : undefined;
		if (!Array.isArray(phases)) continue;
		const tasks = phases.flatMap(phase => Array.isArray(phase?.tasks) ? phase.tasks : []);
		if (tasks.some(task => task?.status === "pending" || task?.status === "in_progress")) return [];
		return tasks.filter(task => task?.status === "blocked" && typeof task.blocker === "string").map(task => task.blocker);
	}
	return [];
}
export default async function kitGoalKeepalive(
	pi: GoalKeepaliveApi,
	deps: { env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<void> {
	const env = deps.env ?? process.env;
	const owner = seatIdentity(env);
	let enabled = false;
	let remove: (() => void) | undefined;
	const clear = () => { remove?.(); remove = undefined; };
	pi.on("goal_updated", ((event: { goal?: { status?: string }; state?: { enabled?: boolean } }) => {
		enabled = event.state?.enabled === true && event.goal?.status === "active";
		if (!enabled) clear();
	}) as (event: never, ctx: GoalKeepaliveContext) => unknown);
	pi.on("agent_end", (_event, ctx) => {
		clear();
		if (!enabled || owner === null) return;
		remove = subscribeReleaseVerdicts(ctx.cwd ?? deps.cwd ?? process.cwd(), owner, blockedEvents(ctx), env.AGENT_MAIL_PROJECT);
	});
	for (const event of ["session_start", "session_switch", "session_stop", "session_shutdown"]) {
		pi.on(event, () => { enabled = false; clear(); });
	}
}

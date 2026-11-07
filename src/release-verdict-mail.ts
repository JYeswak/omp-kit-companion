import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { callAgentMail } from "./fleet-guard/reservations.ts";

const MAX_SUBSCRIPTION_BYTES = 16 * 1024;
const SUBSCRIBERS = "release-verdict-subscribers";

/** Share the keepalive's Git-state resolution with the producer; nested seat cwd is not a mail project key. */
export function releaseVerdictLocation(cwd: string): { state: string; repo: string } | null {
	let root = resolve(cwd);
	for (;;) {
		const git = join(root, ".git");
		try {
			if (statSync(git).isDirectory()) return { state: join(git, "omp-kit"), repo: root };
			if (statSync(git).size <= 4096) {
				const target = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(git, "utf8"))?.[1];
				if (target) return { state: join(resolve(root, target), "omp-kit"), repo: root };
			}
		} catch { /* try the parent repository */ }
		const parent = dirname(root);
		if (parent === root) return null;
		root = parent;
	}
}

/** Same SHA-prefix grammar as the verdict fallback; no short or partial-word matches. */
export function releaseVerdictHeads(events: readonly string[]): string[] {
	return [...new Set(events.flatMap(event => event.match(/\b[0-9a-f]{10,40}\b/gi) ?? []).map(sha => sha.toLowerCase()))];
}

function subscriptionKey(project: string, agent: string): string {
	return createHash("sha256").update(JSON.stringify([project, agent.toLowerCase()])).digest("hex");
}

/** Returns this seat's cleanup; an empty wait removes only its own subscription. No credentials on disk. */
export function subscribeReleaseVerdicts(cwd: string, agent: string, events: readonly string[], project?: string): (() => void) | null {
	const location = releaseVerdictLocation(cwd);
	if (!location) return null;
	project ??= location.repo;
	const path = join(location.state, SUBSCRIBERS, `${subscriptionKey(project, agent)}.json`);
	const remove = () => { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
	const heads = releaseVerdictHeads(events);
	if (heads.length === 0) { remove(); return null; }
	const record = JSON.stringify({ schema: 1, project, agent, heads });
	if (Buffer.byteLength(record) > MAX_SUBSCRIPTION_BYTES) throw new Error("release verdict subscription exceeds size limit");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, record, { mode: 0o600 });
		renameSync(temporary, path);
	} finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
	return remove;
}

interface Subscription { schema: 1; project: string; agent: string; heads: string[] }
function subscription(path: string): Subscription | null {
	try {
		if (statSync(path).size > MAX_SUBSCRIPTION_BYTES) return null;
		const row = JSON.parse(readFileSync(path, "utf8"));
		if (row?.schema !== 1 || typeof row.project !== "string" || typeof row.agent !== "string" || !Array.isArray(row.heads)
			|| !row.heads.every((head: unknown) => typeof head === "string" && /^[0-9a-f]{10,40}$/.test(head))) return null;
		return row;
	} catch { return null; }
}

/** Called after the main judge finishes. Mail is best effort; callers retain its original rc. */
export async function notifyReleaseVerdict(state: string, sha: string, producerRc: number): Promise<void> {
	const directory = join(state, SUBSCRIBERS);
	if (!existsSync(directory)) return;
	const subscribers = readdirSync(directory).filter(name => name.endsWith(".json"))
		.map(name => subscription(join(directory, name)))
		.filter((row): row is Subscription => row !== null && row.heads.some(prefix => sha.startsWith(prefix)));
	if (subscribers.length === 0) return;
	const sender = process.env.AGENT_NAME;
	const senderToken = process.env.AGENT_MAIL_SENDER_TOKEN;
	if (!sender || !senderToken) throw new Error("verdict mail sender identity is unavailable");
	const verdict = producerRc === 0 ? "PASS" : "FAIL";
	const body = `release-verdict: ${sha} producer_rc=${producerRc}`;
	const sentDirectory = join(state, "release-verdict-mail-sent");
	const deadline = AbortSignal.timeout(20_000); // one bounded batch; never delays the verdict indefinitely
	let failed = false;
	for (const row of subscribers) {
		const key = createHash("sha256").update(JSON.stringify([row.project, row.agent.toLowerCase(), sha, producerRc])).digest("hex");
		const sent = join(sentDirectory, key);
		if (existsSync(sent)) continue;
		try {
			const result = await callAgentMail("send_message", {
				project_key: row.project, sender_name: sender, sender_token: senderToken, to: [row.agent],
				subject: `PROGRESS release verdict ${sha} ${verdict}`, body_md: body, ack_required: false,
				idempotency_key: `release-verdict-${key}`,
			}, deadline);
			if (typeof result !== "object" || result === null || !("count" in result) || result.count !== 1) throw new Error("mail delivery unconfirmed");
			mkdirSync(sentDirectory, { recursive: true, mode: 0o700 });
			writeFileSync(sent, "", { mode: 0o600 });
		} catch { failed = true; } // no server response or credential bytes enter the verdict log
	}
	if (failed) throw new Error("one or more verdict mail deliveries failed");
}

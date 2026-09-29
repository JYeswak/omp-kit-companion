// Mock OpenAI Chat Completions streaming server for scripts/e2e-live.sh.
//
// SCEN is a JSON file {turns, chunk}. Turn N answers the Nth request that carries tools
// (a request without tools, e.g. a title or summary call, gets a plain "ok" and does not
// consume a turn). A turn is {text}, {tool:{name,args}}, or both: text streams first, then
// the tool call, in one assistant message. Text and tool arguments stream in chunks of
// `turn.chunk ?? scen.chunk ?? 6` characters; the arguments are raw JSON, which is the
// buffer omp's bash matcher accumulates.
//
// Env: SCEN (scenario file), LOG (every request body appended as JSONL), PORTFILE (the
// server listens on an ephemeral port and writes it here once it accepts connections).
import fs from "node:fs";
import http from "node:http";

const scen = JSON.parse(fs.readFileSync(process.env.SCEN, "utf8"));
const turns = scen.turns ?? [];
const defaultChunk = scen.chunk ?? 6;
const log = process.env.LOG;
let n = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function send(res, delta, finish = null) {
	if (res.destroyed) return;
	res.write(
		`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
	);
}
function pieces(s, size) {
	const out = [];
	for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
	return out;
}

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", c => (body += c));
	req.on("end", async () => {
		res.on("error", () => {});
		if (!req.url.includes("chat/completions")) {
			res.writeHead(404);
			res.end();
			return;
		}
		const parsed = JSON.parse(body);
		const main = Array.isArray(parsed.tools) && parsed.tools.length > 0;
		fs.appendFileSync(log, `${JSON.stringify({ n: main ? n : null, main, body: parsed })}\n`);
		const turn = main ? (turns[n] ?? { text: "Done." }) : { text: "ok" };
		if (main) n++;
		const size = turn.chunk ?? defaultChunk;
		res.writeHead(200, { "content-type": "text/event-stream" });
		send(res, { role: "assistant" });
		if (turn.text) {
			for (const w of pieces(turn.text, size)) {
				send(res, { content: w });
				await sleep(2);
			}
		}
		if (turn.tool) {
			const a = JSON.stringify(turn.tool.args);
			send(res, {
				tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: turn.tool.name, arguments: "" } }],
			});
			for (const p of pieces(a, size)) {
				send(res, { tool_calls: [{ index: 0, function: { arguments: p } }] });
				await sleep(2);
			}
			send(res, {}, "tool_calls");
		} else {
			send(res, {}, "stop");
		}
		if (res.destroyed) return;
		res.write(
			`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "mock", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
server.listen(0, "127.0.0.1", () => {
	fs.writeFileSync(process.env.PORTFILE, String(server.address().port));
});

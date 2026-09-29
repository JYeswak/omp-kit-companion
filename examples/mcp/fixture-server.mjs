// Disposable, credential-free test fixture. Not an installed MCP service.
// OMP's stdio transport uses newline-delimited JSON-RPC 2.0.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
 let request;
 try { request = JSON.parse(line); } catch { continue; }
 if (request.id === undefined || typeof request.method !== "string") continue;
 if (process.argv.includes("--hang")) continue; // bounded startup-timeout negative fixture
 let result;
 switch (request.method) {
  case "initialize":
   result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "omp-kit-disposable", version: "1.0.0" } };
   break;
  case "tools/list":
   result = { tools: [{ name: "proof", description: "Return the isolated fixture marker", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
   break;
  case "tools/call":
   if (request.params?.name !== "proof") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown fixture tool" } })}\n`);
    continue;
   }
   if (process.env.OMP_KIT_FIXTURE_CALL_LOG) appendFileSync(process.env.OMP_KIT_FIXTURE_CALL_LOG, "proof-called\n");
   result = { content: [{ type: "text", text: "omp-kit-fixture-call-ok" }] };
   break;
  default:
   process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } })}\n`);
   continue;
 }
 process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}

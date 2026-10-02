import { expect, test } from "bun:test";
import { buildLspJsonRpcReceipt } from "../../src/lsp-probe.ts";

test("a PASS omits the JSON-RPC receipt ring", () => {
	const receipt = buildLspJsonRpcReceipt("PASS", [{ action: "references", elapsed_ms: 2, result: "secret payload" }]);
	expect(receipt).toBeUndefined();
});

test("an INCOMPLETE result emits a bounded method/id/timing/size-only ring", () => {
	const calls = Array.from({ length: 70 }, (_, index) => ({ action: index === 69 ? "references" : "status", elapsed_ms: index + 0.5, result: "secret payload" }));
	const receipt = buildLspJsonRpcReceipt("INCOMPLETE", calls);
	expect(receipt).toHaveLength(64);
	expect(receipt?.[0]).toEqual({ method: "lsp/status", id: "6", elapsed_ms: 6.5, result_bytes: 14 });
	expect(receipt?.at(-1)).toEqual({ method: "lsp/references", id: "69", elapsed_ms: 69.5, result_bytes: 14 });
	expect(receipt?.[0]).not.toHaveProperty("result");
});

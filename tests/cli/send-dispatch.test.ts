import { expect, test } from "bun:test";
import { dispatchBeads } from "../../src/send.ts";

// ompkit-plii SENDBIND1: a known-prefix bead id in the D-line slug (or AM)
// slot counts as the citation; mail ids never do.

const uds = new Set(["uds"]);

test("planted: bead in the slug position counts with a known prefix", () => {
	const got = dispatchBeads("D AM1 uds-bhd: x", uds);
	expect(got.dispatch).toBe(true);
	expect(got.bead_ids).toEqual(["uds-bhd"]);
});

test("planted: unknown-prefix slug is still refused", () => {
	const got = dispatchBeads("D AM1 follow-up: x", uds);
	expect(got.dispatch).toBe(true);
	expect(got.bead_ids).toEqual([]);
});

test("chief: bead in the AM slot counts without an AM id", () => {
	const got = dispatchBeads("D ompkit-d2hs (P1, done)", new Set(["ompkit"]));
	expect(got.dispatch).toBe(true);
	expect(got.bead_ids).toEqual(["ompkit-d2hs"]);
});

test("unchanged: later tokens and no-prefix calls behave as before", () => {
	expect(dispatchBeads("D AM50091 api uds-bhd: read it", uds).bead_ids).toEqual(["uds-bhd"]);
	expect(dispatchBeads("D AM1 cfs-9yrif: go").bead_ids).toEqual([]);
	expect(dispatchBeads("D AM1 x: cfs-9yrif, ompkit-rc-epic-land-fix-release-dogfood-rz5.125;", new Set(["cfs", "ompkit"])).bead_ids)
		.toEqual(["cfs-9yrif", "ompkit-rc-epic-land-fix-release-dogfood-rz5.125"]);
});

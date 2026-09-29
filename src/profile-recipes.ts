import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PROFILE_RECIPE_KINDS = ["memory-off", "mnemopi-manual", "model-roles"] as const;
export type ProfileRecipeKind = (typeof PROFILE_RECIPE_KINDS)[number];

export interface ProfileRecipe {
	kind: ProfileRecipeKind;
	version: 1;
	content: string;
	status: "UNVERIFIED";
	guidance: string;
}

const recipeNames: Record<ProfileRecipeKind, string> = {
	"memory-off": "memory-off.yml",
	"mnemopi-manual": "mnemopi-manual.yml",
	"model-roles": "model-roles.yml",
};

const profileGuidance = "Choose a NEW, operator-owned named OMP profile, confirm that its name and destination are unused, and copy this recipe as config.yml manually. Refuse any collision: do not merge with, overwrite, clone, or alter an existing profile. These keys were checked against OMP 18.4.2 source; the current installed version and effective profile are UNVERIFIED.";

const guidance: Record<ProfileRecipeKind, string> = {
	"memory-off": `${profileGuidance} Memory is OFF in this example. Effective memory remains UNVERIFIED until inspected safely in the new profile.`,
	"mnemopi-manual": `${profileGuidance} Explicit opt-in: manual retain can store private text; inspect and minimize content before invoking it. autoRetain and autoRecall are false, per-project banks are selected, embeddings and LLM extraction are disabled. Rendering does not request a model, login, or credentials. OMP 18.4.2 backend initialization still resolves provider credentials even with these settings; activation side effects are UNVERIFIED and must be checked in an isolated profile. Effective memory remains UNVERIFIED.`,
	"model-roles": `${profileGuidance} Add a user-chosen provider/model identifier to modelRoles only after verifying it is available in the new profile; a missing role is NOT VERIFIED, an unavailable model is NOT VERIFIED, and a disabled provider is NOT VERIFIED. Discovery provider toggles are not model backend identifiers. No default, fallback, subscription, login or backend enablement is supplied.`,
};

/** Reads a versioned, immutable recipe from the kit bundle; never writes to the release or operator state. */
export function renderRecipe(kind: ProfileRecipeKind, root: string): ProfileRecipe {
	if (!Object.hasOwn(recipeNames, kind)) throw new Error(`Unknown profile recipe: ${kind}`);
	let directory = root;
	for (const segment of ["", "examples", "profiles", "v1"]) {
		if (segment) directory = join(directory, segment);
		if (!lstatSync(directory).isDirectory()) throw new Error(`Unsafe profile recipe directory: ${segment || "release"}`);
	}
	const file = join(directory, recipeNames[kind]);
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`Profile recipe must be a regular file: ${kind}`);
		return { kind, version: 1, content: readFileSync(fd, "utf8"), status: "UNVERIFIED", guidance: guidance[kind] };
	} finally {
		closeSync(fd);
	}
}

/** Validate an operator-supplied NEW name against known existing profiles before suggesting any manual copy. */
export function validateRecipeProfileName(name: string, existingNames: Iterable<string>): string {
	const normalized = name.trim();
	if (
		!normalized || normalized === "default" || normalized === "." || normalized === ".." ||
		normalized.endsWith(".") || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ||
		/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(normalized)
	) throw new Error("Choose a valid NEW OMP profile name, not the default profile or a reserved name.");
	for (const occupied of existingNames) {
		if (occupied.toLowerCase() === normalized.toLowerCase()) {
			throw new Error(`Profile name already exists: ${normalized}. Refusing to overwrite or merge; choose another NEW name.`);
		}
	}
	return normalized;
}

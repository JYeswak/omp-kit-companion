export const RELEASE_DATA = {
	liveScenarios: "tests/live/scenarios.json",
	liveLibrary: "tests/live/lib.mjs",
	liveMockModel: "tests/live/mock-model.mjs",
	integrationScenarios: "tests/live/integrations.json",
	rxWriteEditStream: "scripts/fixtures/rx-write-edit-stream.md",
	rxReferenceConditions: "scripts/fixtures/rx-reference-conditions.json",
	rxReferenceWire: "scripts/fixtures/rx-reference-wire.txt",
} as const;

export const RELEASE_DATA_FILES = Object.values(RELEASE_DATA);

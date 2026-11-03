import { afterAll, test } from "bun:test";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { runCompiledUpdateJourney } from "./kit-update-fixture.ts";

afterAll(() => cleanupAllOwnedTmp());
test("compiled synthetic predecessor authenticates, activates, and leaves unavailable postcheck pending",
 () => runCompiledUpdateJourney("success"), 900_000);

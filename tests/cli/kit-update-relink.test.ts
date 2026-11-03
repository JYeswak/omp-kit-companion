import { afterAll, test } from "bun:test";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { runCompiledUpdateJourney } from "./kit-update-fixture.ts";

afterAll(() => cleanupAllOwnedTmp());
// Independent predecessor: this test does not repeat the successful updater's
// complete ladder merely to prepare the relink-failure witness.
test("compiled updater refuses duplicate profile configuration after a successful live postcheck",
 () => runCompiledUpdateJourney("relink"), 900_000);

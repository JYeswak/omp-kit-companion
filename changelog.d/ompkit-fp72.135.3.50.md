### Fixed

- The bead-lint update gate admits a content edit that repairs a failing bead without making it pass: when the checks the bead fails afterwards are a strict subset of the checks it fails now, the edit lands with a `LINT_REPAIR_ADMITTED` note naming what it cleared and what still fails. Before, a description repair was refused whenever an unrelated failure remained, even one only a checker change could clear. An edit that adds a failure or repairs nothing is still refused, and a content edit combined with `--claim` or `--status` is judged exactly as before. (ompkit-fp72.135.3.50)

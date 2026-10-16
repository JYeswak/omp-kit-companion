### Fixed

- The pre-push fresh gate no longer counts the wait on suites that time out and defer to CI against its 180 s budget, so a large unpublished range can publish; the gate prints `deferred=` and `judged=` seconds (commit 2258e02).

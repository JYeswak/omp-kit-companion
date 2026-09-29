# Security

Please do not publish a suspected security issue or working exploit in an issue or pull request. Use [GitHub's private vulnerability reporting for omp-kit](https://github.com/JYeswak/omp-kit-companion/security/advisories/new) when it is available. If private reporting is not enabled, open an issue requesting a private contact channel **without** including exploit details or sensitive data.

Include the affected omp and omp-kit versions, the rule or script involved, a minimal reproduction with fake data, expected versus observed behavior, and potential impact. Do not send raw sessions, real tokens, personal information, or absolute machine paths.

The kit ships text-matching rules, not a security boundary. A matched rule cannot by itself verify that a cited command ran or prevent every possible tool execution path. Test changes in an isolated home before applying them to live profiles.

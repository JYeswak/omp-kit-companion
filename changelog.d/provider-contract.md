# Isolate provider contract probes

The Ollama provider contract test now skips only the unrelated e2e rule-coverage preflight through a test-only flag. Scenario execution and the pinned/unpinned OLLAMA_HOST assertions remain active.

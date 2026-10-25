# Bulk outputs kept out of git

These ERGO1 (ompkit-rc-epic-land-fix-release-dogfood-rz5.112) outputs exceed 1 MB. They live only in this checkout's working tree and are listed in this dir's .gitignore. Each is pinned here by sha256 so a regenerated copy can be compared byte for byte. `$SKILL` is ~/.claude/skills/agent-ergonomics-and-intuitiveness-maximization-for-cli-tools. Script names are as recorded in phase4_summary.md; check them there before rerunning.

| file | bytes | sha256 | produced by |
|---|---|---|---|
| `audit/phase3_generator_retry.stderr.log` | 27516123 | `242c4b8e464ded4107366cdd7a4fc7bd03b014ff798b8dd4e7f59a5bf852fff5` | bash $SKILL/scripts/generate_intent_corpus.sh (Phase 3 generator retry; stderr only) |
| `audit/agent_surfaces.jsonl` | 12062292 | `dd7db99b662b2841e35f84d0ad1822096a3d89ed23c5d0da7068507ea1606706` | bash $SKILL/scripts/aggregate_scores.sh over audit/partial/*.jsonl (Phase 2 canonical aggregation) |
| `audit/heatmap.svg` | 4171351 | `0552fc6c052d326bec7efe7e220da07d50d9d5666b086f1c98469bed8a063dbe` | bash $SKILL/scripts/render_heatmap.sh audit/agent_surfaces.jsonl (Phase 4) |
| `audit/surface_inventory.jsonl` | 2456450 | `f74462b7c1a5fba797cfa4549e02e2c9db859c665ce244acf151f52ae279f7ca` | bash $SKILL/scripts/inventory_surfaces.sh with bin/omp-kit-src (Phase 1) |
| `audit/intent_inference_corpus.jsonl` | 1431899 | `6abdaf0a4add41006d042c553207b255cd3686e7f1d108ec80c602141b38ff44` | bash $SKILL/scripts/generate_intent_corpus.sh (Phase 3) |
| `audit/phase3_runner_raw.jsonl` | 1394918 | `fc7bc9d98429f49a81e908329592630089c65be854e4f40a54a1939c9335424c` | bash $SKILL/scripts/run_intent_corpus.sh audit/intent_inference_corpus.jsonl (Phase 3 serial runner) |

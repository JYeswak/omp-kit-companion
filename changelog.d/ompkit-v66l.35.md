### Fixed
- Native policy CLI tests reuse the selected, verified OMP SDK source cache with fetching disabled instead of repeatedly preparing sources in isolated homes. Native reads, refusal and race assertions, and test timeouts are unchanged.
- The complete publication suite reuses the focused gate's bounded, isolated Bun workers and timing order without reducing suite coverage or extending its deadline; a passing worker cannot mask another worker's failure.

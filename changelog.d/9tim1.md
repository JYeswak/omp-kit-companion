### Fixed
- Require fresh GitHub CI success on the exact main source SHA in both autocut and `release-local.sh`, independently of the main-role full-suite verdict. Refuse a failed, missing, or unreadable run before cutting or resuming a release.

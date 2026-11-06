### Fixed
- Doctor checks installed rules in per-profile plugin packages instead of requiring legacy rule copies, names missing rule files, distinguishes failed activation probes from confirmed missing rules, and gives an explicit planning-skill repair command.
- Rules doctor follows OMP's profile YAML precedence (`config.yml`, then `config.yaml`), so ignored legacy settings no longer make healthy profiles unverified. Invalid selected YAML and missing rules still report their causes; inspection never migrates profile settings.
- Isolated rule probes now run inside their private HOME, preventing the inspected HOME's default plugin from shadowing named-profile plugins or receiving probe writes.

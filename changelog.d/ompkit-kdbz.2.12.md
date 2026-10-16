### Fixed

- Tern observer parses native OMP v3 tool-result records (`message.role toolResult` with `message.toolCallId` and `message.details.async`) and keeps real metadata records (model_change, custom, thinking_level_change, credential_pin, title_change) in the parent chain instead of refusing the journal. (ompkit-kdbz.2.12)

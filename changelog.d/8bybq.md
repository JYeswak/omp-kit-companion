### Fixed

- A lead whose pane is registered in another project can now mail under that project's key: kit-agent-mail-guard binds the caller's own Tern block by the one name its Agent Mail pane identity files give it once `am agents show` proves that name is registered in the target project, even when `register_agent` wrote no identity file there. A project where the name is not registered is still refused `IDENTITY_UNBOUND`, and the refusal now names the project and the exact `register_agent` remedy (project_key, name, pane_id). (ompkit-8bybq)

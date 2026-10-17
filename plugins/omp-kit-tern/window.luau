-- No timers, automatic settings edits, automatic agent prompts, or background job installation.
-- Commands run only when selected; async callbacks use the fresh context Tern supplies.
tern.command({
    id = "inventory",
    title = "OMP Kit: show host inventory",
    group = "OMP Kit",
    run = function(cx)
        local pane = cx:new_block("omp-kit-tern.runtime", {}, "beside")
        if pane == nil then cx:toast("error", "The host half is not ready", "Check native plugin list/reload and its reported problems.") end
    end,
})
tern.command({
    id = "doctor",
    title = "OMP Kit: inspect Tern integration",
    group = "OMP Kit",
    run = function(cx)
        local binary = tern.getenv("OMP_KIT_BIN") or "omp-kit"
        cx:toast("info", "Running omp-kit tern doctor")
        tern.process.run({binary, "tern", "doctor", "--json"}, {timeout_ms = 10000}, function(result, fresh)
            if fresh == nil then return end
            local good, report = pcall(tern.json.decode, result.stdout)
            if not good or type(report) ~= "table" then
                fresh:toast("error", "Doctor returned no valid envelope", "Inspect the command output locally; no success was inferred.")
                return
            end
            local state = "UNVERIFIED"
            if type(report.data) == "table" then state = tostring(report.data.status or state) end
            local successful = result.status == 0 and report.ok == true and not result.timed_out
            fresh:toast(successful and "info" or "error", "Tern integration: " .. state,
                "This probes availability, not every SDK operation or current fleet behavior.")
        end)
    end,
})
-- A narrow actual export, not an eval endpoint or a fake RPC implementation.
-- No writes, commands or secrets are exposed by this diagnostic.
if tern.carly ~= nil and tern.carly.export ~= nil then
    tern.carly.export("inventory", {
        sig = "inventory() -> {panes: number, agents: number, scope: string}",
        doc = "Read the current window inventory; counts are observations, not health or completion claims.",
    }, function(cx, _call)
        return {panes = #cx.session:panes(), agents = #cx.agents:list(), scope = "window API; agents across sessions"}
    end)
end

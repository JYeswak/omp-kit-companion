-- Native host plugin. This inventory is not a fleet health certificate.
local ui = tern.ui
tern.block.define("runtime", {
    init = function(_cx, _args, _saved)
        return { opened = tern.now() }
    end,
    title = function(_state) return "OMP Kit Runtime Inventory" end,
    view = function(state, _cx)
        local panes = tern.pane.list()
        return { main = ui.col({
            ui.text({ui.span("Native host inventory", "strong")}),
            ui.text({ui.span("Visible host panes: " .. tostring(#panes))}),
            ui.text({ui.span("VM: " .. tern.context .. "; OS: " .. tern.runtime.os)}),
            ui.text({ui.span("An inventory is not proof that every profile loaded its guards.", "muted")}),
        }) }
    end,
    key = function(_state, key, _cx)
        if key.text == "r" then return true end
        return false
    end,
})
-- This lens only claims the two exact command patterns in the manifest.
-- Until a complete JSON envelope and the command's exit status exist, show raw output.
tern.lens.define("result", {
    open = function(_run, _cx) return {text = "", bytes = 0, overflow = false, ended = false} end,
    line = function(state, line)
        -- LensLine.text is native output text; avoid allocating an unbounded capture.
        local text = line.text or ""
        state.bytes = state.bytes + #text + 1
        if state.bytes > 65536 then state.overflow = true; return end
        state.text = state.text .. text .. "\n"
    end,
    finish = function(state, status) state.ended = true; state.exit = status end,
    view = function(state)
        if not state.ended or state.overflow then return nil end
        local good, envelope = pcall(tern.json.decode, state.text)
        if not good or type(envelope) ~= "table" or type(envelope.ok) ~= "boolean" then return nil end
        local data = envelope.data
        local label = "Reported result"
        if type(data) == "table" then label = tostring(data.status or data.overall or label) end
        return ui.card({ui.span("omp-kit result")}, {
            ui.text({ui.span("Command exit: " .. tostring(state.exit))}),
            ui.text({ui.span("Envelope ok: " .. tostring(envelope.ok) .. "; " .. label)}),
            ui.text({ui.span("Native command report; not independent acceptance evidence.", "muted")}),
        })
    end,
})

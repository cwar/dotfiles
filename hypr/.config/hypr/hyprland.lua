-- #######################################################################################
-- Hyprland configuration — Lua format (Hyprland 0.55+)
--
-- Migrated from hyprland.conf. The legacy hyprlang `.conf` format is deprecated:
-- it receives no new features and is slated for removal. See https://hypr.land/news/26_lua/
--
-- Hyprland loads ~/.config/hypr/hyprland.lua if present, otherwise falls back to
-- hyprland.conf. To roll back, just rename/remove this file.
--
-- Validate without applying:  Hyprland --verify-config -c ~/.config/hypr/hyprland.lua
-- Live introspection:         hyprctl eval '<lua>'   (replaces `hyprctl keyword`)
-- #######################################################################################


---------------------------------------------------------------------------------------
-- THEME COLORS
--
-- The hypr-concierge theme switcher writes hyprlang to
-- ~/.config/hyprland-themes/current/colors.conf. Lua has no `source =`, but it *is* a
-- real language, so we parse that file directly. This keeps all 25 saved themes and the
-- theme-rofi / hypr-concierge tooling working untouched — `hyprctl reload` re-runs this
-- file, which re-reads the colors.
--
-- Format handled (both shapes occur across saved themes):
--   col.active_border   = rgba(bd93f9ee) rgba(ff79c6ee) 45deg   -- gradient + angle
--   col.active_border   = rgba(40b038aa)                        -- single colour
---------------------------------------------------------------------------------------

local THEME_COLORS = os.getenv("HOME") .. "/.config/hyprland-themes/current/colors.conf"

--- Parse one `col.<key> = ...` line into a value hl.config() accepts.
--- @return string|table|nil  single colour string, {colors=,angle=} gradient, or nil
local function parse_color_value(spec)
    local colors = {}
    for c in spec:gmatch("rgba?%b()") do
        colors[#colors + 1] = c
    end
    if #colors == 0 then return nil end
    if #colors == 1 then return colors[1] end

    local angle = tonumber(spec:match("(%-?%d+%.?%d*)deg")) or 0
    return { colors = colors, angle = angle }
end

local function apply_theme_colors()
    local f = io.open(THEME_COLORS, "r")
    if not f then return end -- no theme installed yet: fall back to Hyprland defaults
    local text = f:read("a") or ""
    f:close()

    local col = {}
    for key, spec in text:gmatch("col%.([%w_]+)%s*=%s*([^\n]+)") do
        local value = parse_color_value(spec)
        if value then col[key] = value end
    end

    if next(col) then
        hl.config({ general = { col = col } })
    end
end


------------------
---- MONITORS ----
------------------

hl.monitor({ output = "", mode = "preferred", position = "auto", scale = "auto" })
hl.monitor({ output = "HDMI-A-1", mode = "5120x1440@60", position = "0x0", scale = 1 })

-- Laptop lid switch — disable the internal monitor when the lid closes AND an external
-- monitor is connected. The external-monitor guard avoids reconfiguring eDP-1 across S3
-- resume when it's the only display, which segfaulted Hyprland on Meteor Lake / i915
-- (see ~/CLAUDE.md hardware notes). The guard is preserved exactly.
--
-- NOTE: this used to shell out to `hyprctl keyword monitor`, which does NOT work under
-- the Lua config manager ("keyword can't work with non-legacy parsers"). Done natively
-- instead — no subprocess, no parsing of `hyprctl monitors` output.

local function external_monitor_present()
    return #hl.get_monitors() > 1
end

local function disable_internal_display()
    if external_monitor_present() then
        hl.monitor({ output = "eDP-1", disabled = true })
    end
end

local function enable_internal_display()
    hl.monitor({ output = "eDP-1", mode = "preferred", position = "auto", scale = "auto" })
end

local function lid_is_closed()
    local f = io.open("/proc/acpi/button/lid/LID0/state", "r")
    if not f then return false end
    local state = f:read("a") or ""
    f:close()
    return state:match("closed") ~= nil
end

hl.bind("switch:on:Lid Switch", disable_internal_display, { locked = true })
hl.bind("switch:off:Lid Switch", enable_internal_display, { locked = true })


---------------------
---- MY PROGRAMS ----
---------------------

local terminal    = "ghostty"
local fileManager = "ghostty -e yazi"
local menu        = "rofi -show drun"


-------------------
---- AUTOSTART ----
-------------------

-- `exec-once` (startup only) -> hl.on("hyprland.start")
hl.on("hyprland.start", function()
    -- Bind the Hyprland session to systemd so graphical-session.target activates.
    -- Without this, xdg-desktop-portal (Requisite=graphical-session.target) never
    -- starts -> GTK file pickers / portal dialogs silently fail to open.
    hl.exec_cmd("systemctl --user import-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP HYPRLAND_INSTANCE_SIGNATURE")
    hl.exec_cmd("dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_CURRENT_DESKTOP HYPRLAND_INSTANCE_SIGNATURE")
    hl.exec_cmd("systemctl --user start hyprland-session.target")

    hl.exec_cmd("bash ~/.local/bin/waybar-wrapper")
    hl.exec_cmd("hyprpaper")
    hl.exec_cmd("wl-paste --watch cliphist store")
    hl.exec_cmd("mako")
    hl.exec_cmd("hypridle")
    hl.exec_cmd("hypr-monitor-reload") -- auto reload on monitor hotplug (fixes black internal screen after unplug)
end)

-- `exec` (startup AND every reload) -> both events.
-- Re-assert the lid state, in case the lid was closed before this config loaded.
local function sync_lid_state()
    if lid_is_closed() then
        disable_internal_display()
    end
end

hl.on("hyprland.start", sync_lid_state)
hl.on("config.reloaded", sync_lid_state)


-------------------------------
---- ENVIRONMENT VARIABLES ----
-------------------------------

hl.env("XCURSOR_SIZE", "24")
hl.env("HYPRCURSOR_SIZE", "24")
hl.env("XCURSOR_THEME", "Adwaita")

-- XWayland app scaling (for apps like OrcaSlicer, Steam, etc.)
-- With force_zero_scaling = true, apps render at native res and handle their own scaling.
-- GDK_DPI_SCALE tells GTK apps what DPI to use (1.5 matches laptop monitor scale).
hl.env("GDK_DPI_SCALE", "1.5")
hl.env("QT_AUTO_SCREEN_SCALE_FACTOR", "1")
hl.env("QT_SCALE_FACTOR_ROUNDING_POLICY", "RoundPreferFloor")

-- Use portal file dialogs for GTK3 apps (enables yazi filepicker)
hl.env("GTK_USE_PORTAL", "1")


-----------------------
----- PERMISSIONS -----
-----------------------

-- Permission changes require a Hyprland restart; they are not applied on the fly.
-- hl.config({ ecosystem = { enforce_permissions = true } })
-- hl.permission({ binary = "/usr/(bin|local/bin)/grim", type = "screencopy", mode = "allow" })
-- hl.permission({ binary = "/usr/(lib|libexec|lib64)/xdg-desktop-portal-hyprland", type = "screencopy", mode = "allow" })
-- hl.permission({ binary = "/usr/(bin|local/bin)/hyprpm", type = "plugin", mode = "allow" })


-----------------------
---- LOOK AND FEEL ----
-----------------------

hl.config({
    general = {
        gaps_in  = 5,
        gaps_out = 20,

        border_size = 2,

        -- Border colours come from the theme file; see apply_theme_colors() below.

        -- Set to true to enable resizing windows by clicking and dragging on borders/gaps
        resize_on_border = false,

        -- Tearing enabled for gaming (only applies to windows with the `immediate` rule)
        allow_tearing = true,

        layout = "dwindle",
    },

    decoration = {
        rounding       = 10,
        rounding_power = 2,

        active_opacity   = 1.0,
        inactive_opacity = 1.0,

        shadow = { enabled = false },
        blur   = { enabled = false },
    },

    animations = {
        enabled = true,
    },

    dwindle = {
        preserve_split = true,
    },

    master = {
        new_status = "master",
    },

    misc = {
        force_default_wallpaper = -1,    -- Set to 0 or 1 to disable the anime mascot wallpapers
        disable_hyprland_logo   = false, -- If true disables the random hyprland logo. :(
    },

    render = {
        direct_scanout = true,
    },

    -- Cursor fix — force software cursor (Intel i915 workaround)
    cursor = {
        no_hardware_cursors = true,
    },

    -- XWayland: render at native resolution for sharper text
    xwayland = {
        force_zero_scaling = true,
    },
})

-- Applied after the `general` block so theme colours always win.
apply_theme_colors()

-- Animation curves
hl.curve("easeOutQuint",   { type = "bezier", points = { { 0.23, 1 },   { 0.32, 1 } } })
hl.curve("easeInOutCubic", { type = "bezier", points = { { 0.65, 0.05 }, { 0.36, 1 } } })
hl.curve("linear",         { type = "bezier", points = { { 0, 0 },       { 1, 1 } } })
hl.curve("almostLinear",   { type = "bezier", points = { { 0.5, 0.5 },   { 0.75, 1 } } })
hl.curve("quick",          { type = "bezier", points = { { 0.15, 0 },    { 0.1, 1 } } })

hl.animation({ leaf = "global",        enabled = true, speed = 10,   bezier = "default" })
hl.animation({ leaf = "border",        enabled = true, speed = 5.39, bezier = "easeOutQuint" })
hl.animation({ leaf = "windows",       enabled = true, speed = 4.79, bezier = "easeOutQuint" })
hl.animation({ leaf = "windowsIn",     enabled = true, speed = 4.1,  bezier = "easeOutQuint", style = "popin 87%" })
hl.animation({ leaf = "windowsOut",    enabled = true, speed = 1.49, bezier = "linear",       style = "popin 87%" })
hl.animation({ leaf = "fadeIn",        enabled = true, speed = 1.73, bezier = "almostLinear" })
hl.animation({ leaf = "fadeOut",       enabled = true, speed = 1.46, bezier = "almostLinear" })
hl.animation({ leaf = "fade",          enabled = true, speed = 3.03, bezier = "quick" })
hl.animation({ leaf = "layers",        enabled = true, speed = 3.81, bezier = "easeOutQuint" })
hl.animation({ leaf = "layersIn",      enabled = true, speed = 4,    bezier = "easeOutQuint", style = "fade" })
hl.animation({ leaf = "layersOut",     enabled = true, speed = 1.5,  bezier = "linear",       style = "fade" })
hl.animation({ leaf = "fadeLayersIn",  enabled = true, speed = 1.79, bezier = "almostLinear" })
hl.animation({ leaf = "fadeLayersOut", enabled = true, speed = 1.39, bezier = "almostLinear" })
hl.animation({ leaf = "workspaces",    enabled = true, speed = 1.94, bezier = "almostLinear", style = "fade" })
hl.animation({ leaf = "workspacesIn",  enabled = true, speed = 1.21, bezier = "almostLinear", style = "fade" })
hl.animation({ leaf = "workspacesOut", enabled = true, speed = 1.94, bezier = "almostLinear", style = "fade" })
hl.animation({ leaf = "zoomFactor",    enabled = true, speed = 7,    bezier = "quick" })


---------------
---- INPUT ----
---------------

hl.config({
    input = {
        kb_layout  = "us",
        kb_variant = "",
        kb_model   = "",
        kb_options = "",
        kb_rules   = "",

        follow_mouse = 1,

        sensitivity = 0, -- -1.0 - 1.0, 0 means no modification.

        touchpad = {
            natural_scroll = true,
        },
    },
})

hl.gesture({ fingers = 3, direction = "horizontal", action = "workspace" })

hl.device({ name = "epic-mouse-v1", sensitivity = -0.5 })


---------------------
---- KEYBINDINGS ----
---------------------

local mainMod = "SUPER"

-- Flag sets matching the legacy bind variants:
--   bind   -> {}                                bindl  -> { locked = true }
--   binde  -> { repeating = true }              bindel -> { locked = true, repeating = true }
--   bindm  -> { mouse = true }
local LOCKED    = { locked = true }
local REPEAT    = { repeating = true }
local LOCKED_REPEAT = { locked = true, repeating = true }
local MOUSE     = { mouse = true }

hl.bind(mainMod .. " + Return", hl.dsp.exec_cmd(terminal))
hl.bind(mainMod .. " + W", hl.dsp.exec_cmd("~/.local/bin/hypr-undo-close close"))
hl.bind(mainMod .. " + Z", hl.dsp.exec_cmd("~/.local/bin/hypr-undo-close pop"))
hl.bind(mainMod .. " + M", hl.dsp.exit())
hl.bind(mainMod .. " + E", hl.dsp.exec_cmd(fileManager))
hl.bind(mainMod .. " + T", hl.dsp.window.float({ action = "toggle" }))
hl.bind(mainMod .. " + F", hl.dsp.window.fullscreen({ mode = "fullscreen" }))         -- legacy: fullscreen, 0
hl.bind(mainMod .. " + SHIFT + F", hl.dsp.window.fullscreen({ mode = "maximized" }))  -- legacy: fullscreen, 1
hl.bind(mainMod .. " + R", hl.dsp.exec_cmd(menu))
hl.bind(mainMod .. " + Space", hl.dsp.exec_cmd(menu))
hl.bind(mainMod .. " + P", hl.dsp.window.pseudo())          -- dwindle
hl.bind(mainMod .. " + J", hl.dsp.layout("togglesplit"))    -- dwindle

-- Keybindings menu
hl.bind(mainMod .. " + K", hl.dsp.exec_cmd("~/.local/bin/keybinds-menu"))
-- Clipboard history
hl.bind(mainMod .. " + SHIFT + V", hl.dsp.exec_cmd("~/.local/bin/cliphist-rofi"))
hl.bind(mainMod .. " + A", hl.dsp.exec_cmd("ghostty -e ~/.local/bin/audio-picker"))
hl.bind(mainMod .. " + B", hl.dsp.exec_cmd("ghostty --title=bluetooth -e bluetui"))
-- Theme switcher
hl.bind(mainMod .. " + ALT + T", hl.dsp.exec_cmd("~/.local/bin/theme-rofi"))

-- Move focus with mainMod + arrow keys
hl.bind(mainMod .. " + left",  hl.dsp.focus({ direction = "l" }))
hl.bind(mainMod .. " + right", hl.dsp.focus({ direction = "r" }))
hl.bind(mainMod .. " + up",    hl.dsp.focus({ direction = "u" }))
hl.bind(mainMod .. " + down",  hl.dsp.focus({ direction = "d" }))

-- Swap windows with mainMod + SHIFT + arrow keys
hl.bind(mainMod .. " + SHIFT + left",  hl.dsp.window.swap({ direction = "l" }))
hl.bind(mainMod .. " + SHIFT + right", hl.dsp.window.swap({ direction = "r" }))
hl.bind(mainMod .. " + SHIFT + up",    hl.dsp.window.swap({ direction = "u" }))
hl.bind(mainMod .. " + SHIFT + down",  hl.dsp.window.swap({ direction = "d" }))

-- Move window to monitor with mainMod + CTRL + arrow keys
hl.bind(mainMod .. " + CTRL + left",  hl.dsp.window.move({ monitor = "l" }))
hl.bind(mainMod .. " + CTRL + right", hl.dsp.window.move({ monitor = "r" }))

-- Resize windows with mainMod + ALT + arrow keys
hl.bind(mainMod .. " + ALT + left",  hl.dsp.window.resize({ x = -50, y = 0 }), REPEAT)
hl.bind(mainMod .. " + ALT + right", hl.dsp.window.resize({ x = 50,  y = 0 }), REPEAT)
hl.bind(mainMod .. " + ALT + up",    hl.dsp.window.resize({ x = 0,   y = -50 }), REPEAT)
hl.bind(mainMod .. " + ALT + down",  hl.dsp.window.resize({ x = 0,   y = 50 }), REPEAT)

-- Switch workspaces with mainMod + [0-9]; move active window with mainMod + SHIFT + [0-9]
for i = 1, 10 do
    local key = i % 10 -- 10 maps to key 0
    hl.bind(mainMod .. " + " .. key,           hl.dsp.focus({ workspace = i }))
    hl.bind(mainMod .. " + SHIFT + " .. key,   hl.dsp.window.move({ workspace = i }))
end

hl.bind(mainMod .. " + SHIFT + A", hl.dsp.exec_cmd("chromium --app=https://claude.ai"))
hl.bind(mainMod .. " + SHIFT + B", hl.dsp.exec_cmd("chromium"))
hl.bind(mainMod .. " + SHIFT + M", hl.dsp.exec_cmd(
    [[~/.local/bin/launch-or-focus 'Page Load Targets' 'chromium --app=https://grafana.taild0ac70.ts.net/d/tomes-page-load-targets/tomes-e28094-page-load-targets']]))
hl.bind(mainMod .. " + SHIFT + T", hl.dsp.exec_cmd(
    "pgrep -x btop && hyprctl dispatch focuswindow title:btop || " .. terminal .. " --title=btop -e btop"))
hl.bind(mainMod .. " + SHIFT + N", hl.dsp.exec_cmd(terminal .. " -e nvim"))
hl.bind(mainMod .. " + SHIFT + D", hl.dsp.exec_cmd("discord --enable-features=UseOzonePlatform --ozone-platform=wayland"))
hl.bind(mainMod .. " + SHIFT + L", hl.dsp.exec_cmd([[wl-paste | tr -d '\n' | wl-copy]]))

-- Universal copy/paste (Ctrl+Insert / Shift+Insert work everywhere)
hl.bind(mainMod .. " + C", hl.dsp.send_shortcut({ mods = "CTRL",  key = "Insert", window = "activewindow" }))
hl.bind(mainMod .. " + V", hl.dsp.send_shortcut({ mods = "SHIFT", key = "Insert", window = "activewindow" }))
hl.bind(mainMod .. " + X", hl.dsp.send_shortcut({ mods = "CTRL",  key = "X",      window = "activewindow" }))

-- Special workspace (scratchpad)
hl.bind(mainMod .. " + S", hl.dsp.workspace.toggle_special("magic"))
hl.bind(mainMod .. " + SHIFT + S", hl.dsp.window.move({ workspace = "special:magic" }))

-- Scroll through existing workspaces with mainMod + scroll
hl.bind(mainMod .. " + mouse_down", hl.dsp.focus({ workspace = "e+1" }))
hl.bind(mainMod .. " + mouse_up",   hl.dsp.focus({ workspace = "e-1" }))

-- Move/resize windows with mainMod + LMB/RMB and dragging
hl.bind(mainMod .. " + mouse:272", hl.dsp.window.drag(),   MOUSE)
hl.bind(mainMod .. " + mouse:273", hl.dsp.window.resize(), MOUSE)

-- Laptop multimedia keys for volume and LCD brightness
hl.bind("XF86AudioRaiseVolume",  hl.dsp.exec_cmd("wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 5%+"), LOCKED_REPEAT)
hl.bind("XF86AudioLowerVolume",  hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"),      LOCKED_REPEAT)
hl.bind("XF86AudioMute",         hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"),     LOCKED_REPEAT)
hl.bind("XF86AudioMicMute",      hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle"),   LOCKED_REPEAT)
hl.bind("XF86MonBrightnessUp",   hl.dsp.exec_cmd("brightnessctl -e4 -n2 set 5%+"),                  LOCKED_REPEAT)
hl.bind("XF86MonBrightnessDown", hl.dsp.exec_cmd("brightnessctl -e4 -n2 set 5%-"),                  LOCKED_REPEAT)

-- Screenshots - to clipboard
-- NOTE: -t image/png is required. Without it wl-copy shells out to xdg-mime for type
-- detection, which calls xprop, which hangs indefinitely because XWayland is currently
-- broken in this Hyprland session. See ~/CLAUDE.md Hardware Notes.
-- Default Print: hover a window to snap-select it, click-drag for free-form region.
local GRIM_ACTIVE_WINDOW =
    [==[grim -g "$(hyprctl activewindow -j | jq -r '"\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"')"]==]

hl.bind("Print",                       hl.dsp.exec_cmd("/home/cwar/.local/bin/screenshot-smart copy"))
hl.bind("SHIFT + Print",               hl.dsp.exec_cmd("grim - | wl-copy -t image/png"))
hl.bind("CTRL + Print",                hl.dsp.exec_cmd(GRIM_ACTIVE_WINDOW .. " - | wl-copy -t image/png"))
hl.bind(mainMod .. " + Print",         hl.dsp.exec_cmd("/home/cwar/.local/bin/screenshot-smart save"))
-- Screenshots - open in Satty
hl.bind("ALT + Print",                 hl.dsp.exec_cmd("/home/cwar/.local/bin/screenshot-smart satty"))
hl.bind(mainMod .. " + SHIFT + Print", hl.dsp.exec_cmd("grim - | satty --filename -"))
hl.bind(mainMod .. " + CTRL + Print",  hl.dsp.exec_cmd(GRIM_ACTIVE_WINDOW .. " - | satty --filename -"))
hl.bind(mainMod .. " + ALT + Print",   hl.dsp.exec_cmd("wl-paste | satty --filename -"))

-- Requires playerctl
hl.bind("XF86AudioNext",  hl.dsp.exec_cmd("playerctl next"),       LOCKED)
hl.bind("XF86AudioPause", hl.dsp.exec_cmd("playerctl play-pause"), LOCKED)
hl.bind("XF86AudioPlay",  hl.dsp.exec_cmd("playerctl play-pause"), LOCKED)
hl.bind("XF86AudioPrev",  hl.dsp.exec_cmd("playerctl previous"),   LOCKED)

-- Lock screen
hl.bind(mainMod .. " + L", hl.dsp.exec_cmd("hyprlock"))

-- Power menu (shutdown, restart, lock, sleep, etc.)
hl.bind(mainMod .. " + Escape", hl.dsp.exec_cmd("~/.local/bin/power-menu"))

-- Lazygit (opens in focused terminal's cwd)
hl.bind(mainMod .. " + SHIFT + G", hl.dsp.exec_cmd("~/.local/bin/launch-lazygit"))

-- Keyboard mouse control
hl.bind(mainMod .. " + G", hl.dsp.exec_cmd("wl-kbptr"))
hl.bind(mainMod .. " + CTRL + G", hl.dsp.exec_cmd("pkill wl-kbptr"))

-- Claude Code session picker
hl.bind(mainMod .. " + SHIFT + R", hl.dsp.exec_cmd("/home/cwar/.local/bin/claude-sessions"))

-- Screencast (toggle start/stop) — wf-recorder + mic via screencast-smart
hl.bind(mainMod .. " + ALT + R",        hl.dsp.exec_cmd("/home/cwar/.local/bin/screencast-smart full mic"))
hl.bind(mainMod .. " + ALT + CTRL + R", hl.dsp.exec_cmd("/home/cwar/.local/bin/screencast-smart full nomic"))

-- Claude Code project picker — new ghostty running claude-projects
hl.bind(mainMod .. " + SHIFT + P", hl.dsp.exec_cmd("ghostty --title=claude-projects -e /home/cwar/.local/bin/claude-projects"))

-- Toggle monitor input (HDMI1/HDMI2)
hl.bind(mainMod .. " + SHIFT + I", hl.dsp.exec_cmd("~/.local/bin/samsung-input-toggle"))

-- Claude Insights browser
hl.bind(mainMod .. " + ALT + I", hl.dsp.exec_cmd("~/.local/bin/claude-insights rofi"))

-- Showcase - browse personal tweaks & projects
hl.bind(mainMod .. " + ALT + S", hl.dsp.exec_cmd("~/.local/bin/showcase rofi"))

-- Weather TUI
hl.bind(mainMod .. " + SHIFT + W", hl.dsp.exec_cmd(terminal .. " --title=weather -e ~/.local/bin/weather-tui"))

-- Quickshell toggle (custom QML bar)
hl.bind(mainMod .. " + ALT + Q", hl.dsp.exec_cmd("~/.local/bin/quickshell-toggle"))

-- Quickshell lock — keep Super+L on hyprlock until confident with Quickshell lock
hl.bind(mainMod .. " + ALT + L", hl.dsp.exec_cmd("~/.local/bin/quickshell-lock"))

-- Quickshell K8s sidebar (requires quickshell running)
hl.bind(mainMod .. " + ALT + K", hl.dsp.exec_cmd("~/.local/bin/k8s-sidebar-toggle"))


--------------------------------
---- WINDOWS AND WORKSPACES ----
--------------------------------

-- Legacy config needed one `windowrule =` line per property. In Lua a single rule
-- carries all of its effects, so the float/size/center triplets collapse into one call.
--
-- SIZE SYNTAX: the legacy `size 80% 80%` percentage form is NOT supported by the Lua
-- rule parser — it is accepted without error and then silently ignored. Sizes must be
-- expressions over monitor_w / monitor_h (absolute pixel pairs still work). Verified
-- empirically: "80% 80%" left windows at their default size, "monitor_w*0.8 monitor_h*0.8"
-- produced exactly 80%.
local function pct(w, h)
    return string.format("monitor_w*%s monitor_h*%s", w, h)
end

-- Ignore maximize requests from apps. You'll probably like this.
hl.window_rule({
    name  = "suppress-maximize-events",
    match = { class = ".*" },
    suppress_event = "maximize",
})

-- Fix some dragging issues with XWayland
hl.window_rule({
    name  = "fix-xwayland-drags",
    match = { class = "^$", title = "^$", xwayland = true, float = true, fullscreen = false, pin = false },
    no_focus = true,
})

-- btop floating and centered
hl.window_rule({
    name  = "btop-centered",
    match = { title = "^(btop)$" },
    float = true, size = pct(0.8, 0.8), center = true,
})

-- lazygit floating and centered
hl.window_rule({
    name  = "lazygit-centered",
    match = { title = "^(lazygit)$" },
    float = true, size = pct(0.9, 0.9), center = true,
})

-- sysupdate popup
hl.window_rule({
    name  = "sysupdate-popup",
    match = { title = "^(sysupdate)$" },
    float = true, size = pct(0.7, 0.7), center = true,
})

-- yazi file picker (xdg-desktop-portal-termfilechooser)
hl.window_rule({
    name  = "yazi-selector",
    match = { class = "^(yazi-selector)$" },
    float = true, size = pct(0.8, 0.8), center = true,
})

-- Wallpaper preview (hypr-concierge theme skill)
hl.window_rule({
    name  = "wallpaper-preview",
    match = { title = "^(.*Wallpaper Preview.*)$" },
    float = true, size = pct(0.7, 0.8), center = true,
})

-- Hackers screensaver - fullscreen mpv video on each monitor
hl.window_rule({
    name  = "hackers-screensaver",
    match = { title = "^(hackers-screensaver-.*)$" },
    fullscreen = true, no_blur = true, no_shadow = true, decorate = false, no_anim = true,
})
hl.window_rule({
    name  = "hackers-screensaver-edp1",
    match = { title = "^(hackers-screensaver-eDP-1)$" },
    monitor = "eDP-1",
})
hl.window_rule({
    name  = "hackers-screensaver-hdmi",
    match = { title = "^(hackers-screensaver-HDMI-A-1)$" },
    monitor = "HDMI-A-1",
})

-- cwarch screensaver - fullscreen TTE text effects
hl.window_rule({
    name  = "cwarch-screensaver",
    match = { class = [[^(org\.cwarch\.screensaver)$]] },
    fullscreen = true, no_blur = true, no_shadow = true, decorate = false,
})


-----------------------------
---- STEAM & GAMING RULES ---
-----------------------------

-- Steam client - float the UI windows
hl.window_rule({
    name  = "steam-main",
    match = { class = "^(steam)$", title = "^(Steam)$" },
    float = true, size = "1100 700", center = true,
})
hl.window_rule({
    name  = "steam-friends",
    match = { class = "^(steam)$", title = "^(Friends List)$" },
    float = true, size = "460 800",
})

-- Steam games - fullscreen, opaque, no idle, tearing for low latency
hl.window_rule({
    name  = "steam-games",
    match = { class = "^(steam_app_.*)$" },
    fullscreen = true,
    opacity = "1.0 override 1.0 override",
    idle_inhibit = "always",
    -- immediate = true,  -- uncomment to enable tearing for these windows
})

-- Also inhibit idle on the Steam client itself (e.g. during downloads/updates)
hl.window_rule({
    name  = "steam-client-idle",
    match = { class = "^(steam)$" },
    idle_inhibit = "focus",
})

-- GeForce NOW (Nvidia native flatpak — com.nvidia.GeForceNOW). Inhibit idle while
-- focused so the screen doesn't blank mid-stream. Verify class matches with
-- `hyprctl clients` after first launch.
hl.window_rule({
    name  = "geforcenow-idle",
    match = { class = "^(com.nvidia.geforcenow)$" },
    idle_inhibit = "focus",
})

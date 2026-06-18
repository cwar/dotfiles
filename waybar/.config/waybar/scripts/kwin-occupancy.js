// KWin script: report virtual-desktop occupancy to the Waybar helper.
//
// Watches window/desktop events and, on each change, computes the set of
// occupied desktops (desktops that contain at least one normal, non-sticky,
// taskbar-visible window) plus the ordered desktop list and the current
// desktop, then pushes it all to the Waybar helper over D-Bus:
//
//   service  org.waybar.Kwin   path /org/waybar/Kwin   iface org.waybar.Kwin
//   method   Update(s payloadJson)
//
// The helper owns this script's lifecycle (loadScript / unloadScript).

function buildAndSend() {
    var desks = workspace.desktops;        // VirtualDesktop[] in position order
    var cur = workspace.currentDesktop;
    var wins = workspace.windowList();

    var occupied = {};
    for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        if (!w || !w.normalWindow) continue;   // ignore docks/desktops/menus
        if (w.skipTaskbar) continue;           // ignore things hidden from taskbar
        if (w.onAllDesktops) continue;         // sticky windows must not light up every desktop
        var wd = w.desktops;
        if (!wd) continue;
        for (var j = 0; j < wd.length; j++) {
            if (wd[j]) occupied[wd[j].id] = true;
        }
    }

    var desktops = [];
    var occ = [];
    for (var k = 0; k < desks.length; k++) {
        desktops.push({ id: desks[k].id, name: desks[k].name });
        if (occupied[desks[k].id]) occ.push(desks[k].id);
    }

    var payload = JSON.stringify({
        current: cur ? cur.id : "",
        desktops: desktops,
        occupied: occ
    });

    callDBus("org.waybar.Kwin", "/org/waybar/Kwin", "org.waybar.Kwin", "Update", payload);
}

function safeConnect(obj, sig, fn) {
    try {
        if (obj && obj[sig] && obj[sig].connect) obj[sig].connect(fn);
    } catch (e) {}
}

function connectWindow(w) {
    safeConnect(w, "desktopsChanged", buildAndSend);
    safeConnect(w, "skipTaskbarChanged", buildAndSend);
    safeConnect(w, "onAllDesktopsChanged", buildAndSend);
}

// Connect already-existing windows.
var initial = workspace.windowList();
for (var i = 0; i < initial.length; i++) connectWindow(initial[i]);

// Connect workspace-level events (signal names differ across KWin versions,
// so connect defensively to whichever exist).
safeConnect(workspace, "windowAdded", function (w) { connectWindow(w); buildAndSend(); });
safeConnect(workspace, "clientAdded", function (w) { connectWindow(w); buildAndSend(); });
safeConnect(workspace, "windowRemoved", buildAndSend);
safeConnect(workspace, "clientRemoved", buildAndSend);
safeConnect(workspace, "currentDesktopChanged", buildAndSend);
safeConnect(workspace, "desktopsChanged", buildAndSend);

buildAndSend();

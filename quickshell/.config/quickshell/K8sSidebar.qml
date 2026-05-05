import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io

Scope {
    id: root
    property bool visible_: false

    IpcHandler {
        target: "k8s"
        function toggle() { root.visible_ = !root.visible_; if (root.visible_) refresh.running = true }
        function show() { root.visible_ = true; refresh.running = true }
        function hide() { root.visible_ = false }
    }

    property string podsText: "(loading…)"
    property string nodesText: ""
    property string eventsText: ""

    Process {
        id: refresh
        command: ["sh", "-c", "kubectl get pods -A --no-headers 2>&1 | head -40"]
        stdout: StdioCollector { onStreamFinished: root.podsText = text || "(no pods)" }
    }
    Timer {
        interval: 15000; running: root.visible_; repeat: true; triggeredOnStart: true
        onTriggered: { refresh.running = true; nodesProc.running = true; eventsProc.running = true }
    }
    Process {
        id: nodesProc
        command: ["sh", "-c", "kubectl top nodes --no-headers 2>&1 || kubectl get nodes --no-headers 2>&1"]
        stdout: StdioCollector { onStreamFinished: root.nodesText = text }
    }
    Process {
        id: eventsProc
        command: ["sh", "-c", "kubectl get events -A --sort-by=.lastTimestamp 2>&1 | tail -15"]
        stdout: StdioCollector { onStreamFinished: root.eventsText = text }
    }

    PanelWindow {
        visible: root.visible_
        anchors { top: true; right: true; bottom: true }
        implicitWidth: 480
        color: "#1e1e2e"

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 12
            spacing: 10

            Text {
                text: "cwarprime"
                color: "#89b4fa"; font.pixelSize: 18; font.bold: true
            }

            Text { text: "Nodes"; color: "#f9e2af"; font.pixelSize: 13; font.bold: true }
            Text {
                Layout.fillWidth: true
                text: root.nodesText
                color: "#cdd6f4"; font.family: "monospace"; font.pixelSize: 11
                wrapMode: Text.NoWrap
            }

            Text { text: "Pods"; color: "#f9e2af"; font.pixelSize: 13; font.bold: true }
            Flickable {
                Layout.fillWidth: true
                Layout.preferredHeight: 300
                contentWidth: podsLabel.implicitWidth
                contentHeight: podsLabel.implicitHeight
                clip: true
                Text {
                    id: podsLabel
                    text: root.podsText
                    color: "#cdd6f4"; font.family: "monospace"; font.pixelSize: 10
                }
            }

            Text { text: "Recent events"; color: "#f9e2af"; font.pixelSize: 13; font.bold: true }
            Flickable {
                Layout.fillWidth: true
                Layout.fillHeight: true
                contentWidth: eventsLabel.implicitWidth
                contentHeight: eventsLabel.implicitHeight
                clip: true
                Text {
                    id: eventsLabel
                    text: root.eventsText
                    color: "#bac2de"; font.family: "monospace"; font.pixelSize: 10
                }
            }

            Text {
                text: "Press Super+Alt+K again to close"
                color: "#6c7086"; font.pixelSize: 10
            }
        }
    }
}

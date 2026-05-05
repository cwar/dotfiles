import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland

PanelWindow {
    anchors { top: true; left: true; right: true }
    implicitHeight: 32
    color: "#1e1e2e"

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 8
        anchors.rightMargin: 8
        spacing: 12

        RowLayout {
            spacing: 4
            Repeater {
                model: Hyprland.workspaces
                Rectangle {
                    required property var modelData
                    implicitWidth: 28; implicitHeight: 22; radius: 4
                    color: modelData.active ? "#89b4fa" : "#313244"
                    Text {
                        anchors.centerIn: parent
                        text: parent.modelData.id
                        color: parent.modelData.active ? "#1e1e2e" : "#cdd6f4"
                        font.pixelSize: 12
                    }
                    MouseArea {
                        anchors.fill: parent
                        onClicked: Hyprland.dispatch("workspace " + parent.modelData.id)
                    }
                }
            }
        }

        Item { Layout.fillWidth: true }

        Text {
            id: battery
            color: "#cdd6f4"; font.pixelSize: 12
            text: "bat —"
        }
        Timer {
            interval: 30000; running: true; repeat: true; triggeredOnStart: true
            onTriggered: batteryPoll.running = true
        }
        Process {
            id: batteryPoll
            command: ["sh", "-c", "cat /sys/class/power_supply/BAT*/capacity 2>/dev/null | head -1"]
            stdout: SplitParser { onRead: line => battery.text = "bat " + line + "%" }
        }

        Text {
            id: clock
            color: "#cdd6f4"; font.pixelSize: 12; font.family: "monospace"
            text: Qt.formatDateTime(new Date(), "ddd MMM d  hh:mm")
        }
        Timer {
            interval: 1000; running: true; repeat: true
            onTriggered: clock.text = Qt.formatDateTime(new Date(), "ddd MMM d  hh:mm")
        }
    }
}

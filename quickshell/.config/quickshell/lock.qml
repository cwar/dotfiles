import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import Quickshell.Services.Pam

WlSessionLock {
    id: lock
    locked: true

    WlSessionLockSurface {
        Rectangle {
            anchors.fill: parent
            color: "#08090d"

            Rectangle {
                anchors.fill: parent
                gradient: Gradient {
                    GradientStop { position: 0.0; color: "#0b0d14" }
                    GradientStop { position: 1.0; color: "#1a1b26" }
                }
            }

            ColumnLayout {
                anchors.centerIn: parent
                spacing: 24
                width: 360

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: Qt.formatDateTime(clock.now, "hh:mm")
                    color: "#a8aeb8"
                    font.pixelSize: 96
                    font.family: "JetBrainsMono Nerd Font"
                }
                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: Qt.formatDateTime(clock.now, "dddd, MMMM d")
                    color: "#5c8cc4"
                    font.pixelSize: 18
                    font.family: "JetBrainsMono Nerd Font"
                }
                Timer {
                    id: clock
                    property date now: new Date()
                    interval: 1000; running: true; repeat: true
                    onTriggered: now = new Date()
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 50
                    radius: 4
                    color: "#0b0d14"
                    border.color: pam.active ? "#d4a437" : (status.text.startsWith("Wrong") ? "#b83a3a" : "#5c8cc4")
                    border.width: 3

                    TextInput {
                        id: pwField
                        anchors.fill: parent
                        anchors.margins: 12
                        color: "#a8aeb8"
                        font.pixelSize: 18
                        font.family: "JetBrainsMono Nerd Font"
                        echoMode: TextInput.Password
                        focus: true
                        verticalAlignment: TextInput.AlignVCenter

                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: "Password…"
                            color: "#555866"
                            font: pwField.font
                            visible: pwField.text.length === 0
                        }

                        onAccepted: {
                            if (pam.active) return
                            pam.start()
                        }
                    }
                }

                Text {
                    id: status
                    Layout.alignment: Qt.AlignHCenter
                    color: text.startsWith("Wrong") ? "#b83a3a" : "#5c8cc4"
                    font.pixelSize: 14
                    text: pam.active ? "Checking…" : ""
                }
            }

            PamContext {
                id: pam
                config: "hyprlock"
                onPamMessage: pwField.text
                onResponseRequiredChanged: {
                    if (responseRequired) respondWith(pwField.text)
                }
                onCompleted: result => {
                    if (result === PamResult.Success) {
                        lock.locked = false
                        Qt.quit()
                    } else {
                        status.text = "Wrong password"
                        pwField.text = ""
                        pwField.forceActiveFocus()
                    }
                }
            }
        }
    }
}

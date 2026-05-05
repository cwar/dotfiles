import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Services.Notifications

Scope {
    NotificationServer {
        id: server
        keepOnReload: false
        actionsSupported: true
        bodyMarkupSupported: true
        bodyImagesSupported: true
        imageSupported: true

        onNotification: notif => {
            notif.tracked = true
            toastModel.append({ notif: notif })
            dismissTimer.createFor(notif)
        }
    }

    ListModel { id: toastModel }

    Component {
        id: dismissTimer
        Timer {
            property var notif
            interval: notif && notif.expireTimeout > 0 ? notif.expireTimeout : 5000
            running: true
            onTriggered: {
                for (let i = 0; i < toastModel.count; i++) {
                    if (toastModel.get(i).notif === notif) { toastModel.remove(i); break }
                }
                notif.dismiss()
                destroy()
            }
            function createFor(n) {}
        }
    }

    function createFor(n) {
        const t = dismissTimer.createObject(server, { notif: n })
    }

    Variants {
        model: Quickshell.screens
        PanelWindow {
            required property var modelData
            screen: modelData
            anchors { top: true; right: true }
            margins { top: 40; right: 16 }
            implicitWidth: 380
            implicitHeight: Math.max(1, column.implicitHeight)
            color: "transparent"

            ColumnLayout {
                id: column
                width: parent.width
                spacing: 8

                Repeater {
                    model: toastModel
                    Rectangle {
                        required property var notif
                        Layout.fillWidth: true
                        implicitHeight: content.implicitHeight + 20
                        radius: 10
                        color: "#1e1e2e"
                        border.color: notif.urgency === NotificationUrgency.Critical ? "#f38ba8" : "#89b4fa"
                        border.width: 2

                        ColumnLayout {
                            id: content
                            anchors.fill: parent
                            anchors.margins: 10
                            spacing: 4
                            Text {
                                text: notif.summary
                                color: "#cdd6f4"
                                font.pixelSize: 13; font.bold: true
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                            }
                            Text {
                                text: notif.body
                                color: "#bac2de"
                                font.pixelSize: 12
                                wrapMode: Text.WordWrap
                                visible: text.length > 0
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                            }
                        }
                        MouseArea {
                            anchors.fill: parent
                            onClicked: {
                                for (let i = 0; i < toastModel.count; i++) {
                                    if (toastModel.get(i).notif === notif) { toastModel.remove(i); break }
                                }
                                notif.dismiss()
                            }
                        }
                    }
                }
            }
        }
    }

    Component.onCompleted: server.onNotification.connect(n => createFor(n))
}

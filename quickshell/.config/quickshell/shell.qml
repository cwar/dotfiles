import QtQuick
import Quickshell

Scope {
    Variants {
        model: Quickshell.screens
        Bar { required property var modelData; screen: modelData }
    }

    Notifications {}
    K8sSidebar {}
}

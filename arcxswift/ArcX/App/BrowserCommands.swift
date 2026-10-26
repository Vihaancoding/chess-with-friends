import SwiftUI
import AppKit

struct BrowserCommands: Commands {
    @ObservedObject var state: BrowserState
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Tab") { state.showCommandBar(newTab: true) }
                .keyboardShortcut("t")
            Button("Open Location…") { state.showCommandBar(newTab: false) }
                .keyboardShortcut("l")
            Button("Reopen Closed Tab") { state.reopenClosedTab() }
                .keyboardShortcut("t", modifiers: [.command, .shift])
                .disabled(state.closedTabs.isEmpty)
            Divider()
            Button("Import from Arc…") { openWindow(id: "arc-import") }
        }

        // Replaces File > Close (Cmd+W) and Save (Cmd+S).
        CommandGroup(replacing: .saveItem) {
            Button("Close Tab") { state.closeSelectedTab() }
                .keyboardShortcut("w")
            Button("Close Window") { NSApp.keyWindow?.performClose(nil) }
                .keyboardShortcut("w", modifiers: [.command, .shift])
        }

        CommandGroup(replacing: .textEditing) {
            Button("Find…") { state.showFindBar() }
                .keyboardShortcut("f")
            Button("Find Next") { state.find(backwards: false) }
                .keyboardShortcut("g")
            Button("Find Previous") { state.find(backwards: true) }
                .keyboardShortcut("g", modifiers: [.command, .shift])
        }

        CommandGroup(replacing: .sidebar) {
            Button(state.sidebarVisible ? "Hide Sidebar" : "Show Sidebar") { state.toggleSidebar() }
                .keyboardShortcut("s")
            Divider()
            Button("Reload Page") { state.reload() }
                .keyboardShortcut("r")
            Button("Stop Loading") { state.stopLoading() }
                .keyboardShortcut(".")
            Divider()
            Button("Zoom In") { state.zoom(step: 0.1) }
                .keyboardShortcut("=")
            Button("Zoom Out") { state.zoom(step: -0.1) }
                .keyboardShortcut("-")
            Button("Actual Size") { state.zoom(step: nil) }
                .keyboardShortcut("0")
            Divider()
            Button(state.splitTabID == nil ? "Open Split View" : "Close Split View") { state.toggleSplit() }
                .keyboardShortcut("=", modifiers: [.control, .shift])
        }

        CommandMenu("History") {
            Button("Back") { state.goBack() }
                .keyboardShortcut("[")
            Button("Forward") { state.goForward() }
                .keyboardShortcut("]")
            Divider()
            Button("Show All History") { openWindow(id: "history") }
                .keyboardShortcut("y")
        }

        CommandMenu("Tabs") {
            Button("Next Tab") { state.selectAdjacentTab(offset: 1) }
                .keyboardShortcut(.tab, modifiers: [.control])
            Button("Previous Tab") { state.selectAdjacentTab(offset: -1) }
                .keyboardShortcut(.tab, modifiers: [.control, .shift])
            Divider()
            Button("Pin / Unpin Tab") {
                if let tab = state.selectedTab { state.togglePin(tab) }
            }
            .keyboardShortcut("d")
            Button("Add to Favorites") {
                if let tab = state.selectedTab { state.addToFavorites(tab) }
            }
            Divider()
            ForEach(1..<10, id: \.self) { number in
                Button("Select Tab \(number)") { state.selectTab(atIndex: number - 1) }
                    .keyboardShortcut(KeyEquivalent(Character(String(number))), modifiers: .command)
            }
        }

        CommandMenu("Spaces") {
            ForEach(Array(state.spaces.prefix(9).enumerated()), id: \.element.id) { index, space in
                Button(space.name) { state.selectSpace(space) }
                    .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .control)
            }
        }

        CommandGroup(after: .windowArrangement) {
            Divider()
            Button("Tab Memory (Debug)") { openWindow(id: "memory") }
                .keyboardShortcut("m", modifiers: [.command, .option])
            Button("Import from Arc…") { openWindow(id: "arc-import") }
        }
    }
}

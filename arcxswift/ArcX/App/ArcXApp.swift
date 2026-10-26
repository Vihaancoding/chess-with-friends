import SwiftUI
import AppKit

@main
struct ArcXApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var state = BrowserState()

    var body: some Scene {
        Window("ArcX", id: "main") {
            BrowserWindowView()
                .environmentObject(state)
                .environmentObject(state.downloads)
                .frame(minWidth: 760, minHeight: 480)
                .onAppear { appDelegate.state = state }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 820)
        .commands { BrowserCommands(state: state) }

        Window("History & Bookmarks", id: "history") {
            HistoryView()
                .environmentObject(state)
        }
        .defaultSize(width: 680, height: 560)

        Window("Tab Memory", id: "memory") {
            MemoryDebugView()
                .environmentObject(state)
        }
        .defaultSize(width: 760, height: 480)

        Window("Import from Arc", id: "arc-import") {
            ArcImportView()
                .environmentObject(state)
        }
        .defaultSize(width: 600, height: 720)

        Settings {
            SettingsView()
                .environmentObject(state)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var state: BrowserState?

    func applicationWillTerminate(_ notification: Notification) {
        state?.saveNow(synchronously: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

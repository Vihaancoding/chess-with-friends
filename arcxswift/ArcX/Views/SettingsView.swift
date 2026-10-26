import SwiftUI
import AppKit

struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettingsView()
                .tabItem { Label("General", systemImage: "gearshape") }
            PrivacySettingsView()
                .tabItem { Label("Privacy", systemImage: "hand.raised") }
            ImportSettingsView()
                .tabItem { Label("Import", systemImage: "square.and.arrow.down") }
            PasswordsSettingsView()
                .tabItem { Label("Passwords", systemImage: "key") }
        }
        .frame(width: 560, height: 440)
    }
}

private struct GeneralSettingsView: View {
    @EnvironmentObject private var state: BrowserState
    @Environment(\.openWindow) private var openWindow
    @AppStorage(TabSleepManager.minutesKey) private var sleepMinutes = TabSleepManager.defaultMinutes

    private let options: [(String, Int)] = [
        ("1 minute", 1), ("5 minutes", 5), ("10 minutes", 10), ("15 minutes", 15),
        ("30 minutes", 30), ("1 hour", 60), ("2 hours", 120), ("Never", 0)
    ]

    var body: some View {
        Form {
            Section("Tab sleeping") {
                Picker("Put background tabs to sleep after", selection: $sleepMinutes) {
                    ForEach(options.indices, id: \.self) { index in
                        Text(options[index].0).tag(options[index].1)
                    }
                }
                Text("Sleeping tabs release their WebKit process and keep only URL, title, favicon, scroll position and a small snapshot. Tabs playing audio or video, in Picture in Picture, in fullscreen, using the camera/microphone, or downloading are never put to sleep.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Open Tab Memory Debug View") { openWindow(id: "memory") }
            }
            Section("Search") {
                LabeledContent("Search engine", value: "DuckDuckGo")
            }
        }
        .formStyle(.grouped)
        .onChange(of: sleepMinutes) {
            state.sleepManager.reschedule()
        }
    }
}

private struct PrivacySettingsView: View {
    @EnvironmentObject private var state: BrowserState
    @AppStorage(ContentBlocker.enabledKey) private var blockerEnabled = true
    @State private var clearing = false
    @State private var cleared: String?

    var body: some View {
        Form {
            Section("Content blocking") {
                Toggle("Block common ads and trackers", isOn: $blockerEnabled)
                BlockerStatus(blocker: state.contentBlocker)
                Text("Uses WebKit’s compiled content rule lists (WKContentRuleList). Blocking happens inside WebKit — no JavaScript is injected into pages.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Website data") {
                if let space = state.currentSpace {
                    LabeledContent("Current space", value: space.name)
                    Button(clearing ? "Clearing…" : "Clear Cookies & Website Data for “\(space.name)”") {
                        clearing = true
                        Task {
                            await state.clearWebsiteData(for: space)
                            clearing = false
                            cleared = "Cleared website data for \(space.name)."
                        }
                    }
                    .disabled(clearing)
                }
                if let cleared {
                    Text(cleared).font(.caption).foregroundStyle(.secondary)
                }
                Text("Every space has its own isolated, persistent cookie and storage container.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onChange(of: blockerEnabled) {
            state.applyContentBlocker()
        }
    }
}

private struct BlockerStatus: View {
    @ObservedObject var blocker: ContentBlocker

    var body: some View {
        LabeledContent("Status", value: blocker.status)
    }
}

private struct ImportSettingsView: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Form {
            Section("Arc") {
                Text("Import spaces, pinned tabs, favorites, folders, open tabs, bookmarks and history from Arc. Passwords and cookies are optional and need extra confirmation.")
                    .font(.callout)
                Button("Import from Arc…") { openWindow(id: "arc-import") }
            }
            Section("What can’t be imported") {
                ForEach(ArcImporter.notImportable, id: \.self) { line in
                    Text("• " + line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }
}

struct PasswordsSettingsView: View {
    @State private var items: [KeychainStore.Item] = []
    @State private var copied: String?
    @State private var confirmDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Passwords imported by ArcX are stored in your macOS login Keychain. ArcX does not autofill forms (WKWebView has no public password-autofill API for third-party browsers) — copy a password when you need it. The clipboard is cleared after 60 seconds.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            List(items) { item in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.server)
                        Text(item.account).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(copied == item.id ? "Copied" : "Copy Password") { copy(item) }
                        .buttonStyle(.borderless)
                }
            }
            .overlay {
                if items.isEmpty {
                    Text("No imported passwords.").foregroundStyle(.secondary)
                }
            }

            HStack {
                Button("Refresh") { reload() }
                Spacer()
                Button("Delete All Imported Passwords…", role: .destructive) { confirmDelete = true }
                    .disabled(items.isEmpty)
            }
        }
        .padding(16)
        .onAppear(perform: reload)
        .confirmationDialog("Delete all passwords ArcX imported into the Keychain?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) {
                KeychainStore.deleteAllImported()
                reload()
            }
        }
    }

    private func reload() {
        items = KeychainStore.listImported()
    }

    private func copy(_ item: KeychainStore.Item) {
        guard let password = KeychainStore.password(server: item.server, account: item.account) else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(password, forType: .string)
        let changeCount = pasteboard.changeCount
        copied = item.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
            if NSPasteboard.general.changeCount == changeCount {
                NSPasteboard.general.clearContents()
            }
        }
    }
}

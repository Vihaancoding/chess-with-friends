import SwiftUI

/// "Memory per tab" debug view. Refreshes only on demand (no timers).
struct MemoryDebugView: View {
    @EnvironmentObject private var state: BrowserState
    @State private var rows: [TabMemoryRow] = []
    @State private var footprint: UInt64 = 0
    @State private var refreshedAt = Date()
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 24) {
                stat("ArcX app process", AppMemory.format(footprint))
                stat("Live WKWebViews", "\(rows.filter { $0.awake }.count)")
                stat("Sleeping tabs", "\(rows.filter { !$0.awake }.count)")
                stat("Snapshots", AppMemory.format(UInt64(rows.reduce(0) { $0 + $1.snapshotBytes })))
                Spacer()
                SleeperStatus(manager: state.sleepManager)
            }
            .padding(14)

            Divider()

            Table(rows) {
                TableColumn("State") { row in
                    Label(row.awake ? "Awake" : "Asleep", systemImage: row.awake ? "bolt.fill" : "moon.zzz.fill")
                        .foregroundStyle(row.awake ? Color.orange : Color.secondary)
                }
                .width(min: 70, ideal: 80, max: 90)
                TableColumn("Tab") { row in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.title).lineLimit(1)
                        Text(row.url).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                TableColumn("Space") { row in Text(row.space) }
                    .width(min: 60, ideal: 90, max: 140)
                TableColumn("Inactive") { row in Text(row.inactive) }
                    .width(min: 60, ideal: 70, max: 90)
                TableColumn("Snapshot") { row in
                    Text(row.snapshotBytes > 0 ? AppMemory.format(UInt64(row.snapshotBytes)) : "—")
                }
                .width(min: 60, ideal: 70, max: 90)
                TableColumn("Notes") { row in
                    Text(row.notes).foregroundStyle(.secondary).lineLimit(1)
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Button("Refresh") { refresh() }
                    Button("Run Sleep Check Now") {
                        state.sleepManager.sweep()
                        Task {
                            try? await Task.sleep(for: .milliseconds(600))
                            refresh()
                        }
                    }
                    Button("Sleep All Background Tabs") {
                        Task {
                            let count = await state.sleepManager.sleepAllBackgroundTabs()
                            message = "Put \(count) tab(s) to sleep."
                            refresh()
                        }
                    }
                    Spacer()
                    if let message {
                        Text(message).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Text("Each awake tab has its own WebKit “WebContent” process. macOS doesn’t expose per-WKWebView memory through public API, so open Activity Monitor and search “WebContent” (or “ArcX Web Content”) to watch those processes disappear when tabs sleep. Refreshed \(refreshedAt.formatted(date: .omitted, time: .standard)).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(14)
        }
        .frame(minWidth: 640, minHeight: 360)
        .onAppear(perform: refresh)
    }

    private func stat(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.monospacedDigit().weight(.semibold))
        }
    }

    private func refresh() {
        footprint = AppMemory.footprintBytes()
        refreshedAt = Date()
        let now = Date()
        rows = state.spaces.flatMap { space in
            space.allTabs.map { tab in
                var notes: [String] = []
                if state.isVisible(tab) { notes.append("visible") }
                if tab.isPinned { notes.append("pinned") }
                if tab.activeDownloads > 0 { notes.append("downloading") }
                if let slept = tab.sleptAt, tab.isAsleep {
                    notes.append("asleep since \(slept.formatted(date: .omitted, time: .shortened))")
                }
                let inactiveMinutes = Int(now.timeIntervalSince(tab.lastActive) / 60)
                return TabMemoryRow(
                    id: tab.id,
                    awake: !tab.isAsleep,
                    title: tab.displayTitle,
                    url: tab.url?.absoluteString ?? "",
                    space: space.name,
                    inactive: state.isVisible(tab) ? "now" : "\(inactiveMinutes) min",
                    snapshotBytes: tab.snapshotBytes,
                    notes: notes.joined(separator: ", ")
                )
            }
        }
    }
}

private struct SleeperStatus: View {
    @ObservedObject var manager: TabSleepManager

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(sleepSetting).font(.caption).foregroundStyle(.secondary)
            Text(manager.isPaused ? "Sleep timer paused (window hidden)" : "Sleep timer running")
                .font(.caption)
            if let last = manager.lastSweep {
                Text("Last check \(last.formatted(date: .omitted, time: .standard)) · \(manager.tabsSleptTotal) slept")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var sleepSetting: String {
        guard let seconds = manager.sleepAfter else { return "Tab sleeping: never" }
        return "Sleep after \(Int(seconds / 60)) min"
    }
}

struct TabMemoryRow: Identifiable {
    let id: UUID
    let awake: Bool
    let title: String
    let url: String
    let space: String
    let inactive: String
    let snapshotBytes: Int
    let notes: String
}

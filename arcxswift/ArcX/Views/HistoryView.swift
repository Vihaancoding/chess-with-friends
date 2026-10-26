import SwiftUI

struct HistoryView: View {
    @EnvironmentObject private var state: BrowserState
    @State private var query = ""
    @State private var mode = 0
    @State private var confirmClear = false

    private static let maxRows = 600

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("", selection: $mode) {
                    Text("History").tag(0)
                    Text("Bookmarks").tag(1)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 220)
                Spacer()
                TextField("Search", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 220)
            }
            .padding(12)

            Divider()

            if mode == 0 {
                historyList
            } else {
                bookmarkList
            }

            Divider()
            HStack {
                Text(mode == 0 ? "\(state.history.count) entries" : "\(state.bookmarks.count) bookmarks")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if mode == 0 {
                    Button("Clear History…") { confirmClear = true }
                        .disabled(state.history.isEmpty)
                }
            }
            .padding(10)
        }
        .confirmationDialog("Clear all browsing history?", isPresented: $confirmClear) {
            Button("Clear History", role: .destructive) { state.clearHistory() }
        }
    }

    private var filteredHistory: [HistoryEntry] {
        let needle = query.lowercased()
        var result: [HistoryEntry] = []
        for entry in state.history.reversed() {
            if result.count >= Self.maxRows { break }
            if needle.isEmpty || entry.title.lowercased().contains(needle) || entry.url.absoluteString.lowercased().contains(needle) {
                result.append(entry)
            }
        }
        return result
    }

    private var filteredBookmarks: [Bookmark] {
        let needle = query.lowercased()
        guard !needle.isEmpty else { return state.bookmarks }
        return state.bookmarks.filter {
            $0.title.lowercased().contains(needle) || $0.url.absoluteString.lowercased().contains(needle)
                || ($0.folder?.lowercased().contains(needle) ?? false)
        }
    }

    private var historyList: some View {
        List(filteredHistory) { entry in
            HStack(spacing: 10) {
                Image(systemName: "clock")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.title.isEmpty ? entry.url.absoluteString : entry.title)
                        .lineLimit(1)
                    Text(entry.url.absoluteString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Text(entry.date, format: .dateTime.month(.abbreviated).day().hour().minute())
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { state.newTab(url: entry.url) }
            .contextMenu {
                Button("Open in New Tab") { state.newTab(url: entry.url) }
                Button("Copy Link") { copyToPasteboard(entry.url.absoluteString) }
            }
        }
        .overlay {
            if filteredHistory.isEmpty {
                Text(query.isEmpty ? "No history yet." : "No matches.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var bookmarkList: some View {
        List(filteredBookmarks) { bookmark in
            HStack(spacing: 10) {
                Image(systemName: "bookmark")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(bookmark.title)
                        .lineLimit(1)
                    Text(bookmark.folder.map { "\($0) — \(bookmark.url.absoluteString)" } ?? bookmark.url.absoluteString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
            }
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { state.newTab(url: bookmark.url) }
            .contextMenu {
                Button("Open in New Tab") { state.newTab(url: bookmark.url) }
                Button("Copy Link") { copyToPasteboard(bookmark.url.absoluteString) }
                Divider()
                Button("Delete Bookmark", role: .destructive) { state.removeBookmark(bookmark) }
            }
        }
        .overlay {
            if filteredBookmarks.isEmpty {
                Text("No bookmarks. Import them from Arc via File › Import from Arc…")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

import SwiftUI

/// Centered floating command bar (⌘T / ⌘L). Suggestions come only from in-memory data
/// (open tabs, favorites, bookmarks, history) — no preview web views are created.
struct CommandBarView: View {
    @EnvironmentObject private var state: BrowserState
    let opensNewTab: Bool

    @State private var text: String
    @State private var highlighted = 0
    @FocusState private var focused: Bool

    init(initialText: String, opensNewTab: Bool) {
        self.opensNewTab = opensNewTab
        _text = State(initialValue: initialText)
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.18)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { state.hideCommandBar() }

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: opensNewTab ? "plus.magnifyingglass" : "magnifyingglass")
                        .font(.system(size: 17))
                        .foregroundStyle(.secondary)
                    TextField(opensNewTab ? "Search or enter URL…" : "Go to URL or search…", text: $text)
                        .textFieldStyle(.plain)
                        .font(.system(size: 19))
                        .focused($focused)
                        .onSubmit { activate(highlighted) }
                        .onExitCommand { state.hideCommandBar() }
                        .onKeyPress(.downArrow) {
                            moveHighlight(1)
                            return .handled
                        }
                        .onKeyPress(.upArrow) {
                            moveHighlight(-1)
                            return .handled
                        }
                }
                .padding(.horizontal, 16)
                .frame(height: 54)

                let items = suggestions
                if !items.isEmpty {
                    Divider()
                    ScrollView {
                        VStack(spacing: 2) {
                            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                                SuggestionRow(suggestion: item, highlighted: index == highlighted)
                                    .onTapGesture { activate(index) }
                                    .onHover { inside in if inside { highlighted = index } }
                            }
                        }
                        .padding(6)
                    }
                    .frame(maxHeight: 380)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(width: 640)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.3), radius: 30, y: 12)
            .padding(.top, 110)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { focused = true }
        .onChange(of: text) { highlighted = 0 }
    }

    private func moveHighlight(_ delta: Int) {
        let count = suggestions.count
        guard count > 0 else { return }
        highlighted = (highlighted + delta + count) % count
    }

    private func activate(_ index: Int) {
        let items = suggestions
        guard !items.isEmpty else {
            state.hideCommandBar()
            return
        }
        let item = items[min(max(index, 0), items.count - 1)]
        switch item.action {
        case .open(let url):
            state.open(url, inNewTab: opensNewTab)
        case .switchTo(let tab):
            state.select(tab)
        }
        state.hideCommandBar()
    }

    // MARK: Suggestions

    private var suggestions: [Suggestion] {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var results: [Suggestion] = []
        var seenURLs = Set<String>()

        if query.isEmpty {
            for tab in (state.currentSpace?.allTabs ?? []).prefix(8) {
                results.append(.tab(tab))
            }
            return results
        }

        if let url = URLParser.url(from: query) {
            results.append(Suggestion(id: "go:\(url.absoluteString)", title: url.absoluteString, subtitle: "Open URL",
                                      icon: "arrow.up.right.circle", pageURL: nil, action: .open(url)))
            seenURLs.insert(url.absoluteString)
        }
        results.append(Suggestion(id: "search:\(query)", title: query, subtitle: "Search DuckDuckGo",
                                  icon: "magnifyingglass", pageURL: nil, action: .open(URLParser.searchURL(for: query))))

        let needle = query.lowercased()
        func matches(_ title: String, _ url: URL?) -> Bool {
            title.lowercased().contains(needle) || (url?.absoluteString.lowercased().contains(needle) ?? false)
        }

        // Open tabs across all spaces.
        var tabCount = 0
        for tab in state.allTabs where tabCount < 6 && matches(tab.displayTitle, tab.url) {
            results.append(.tab(tab))
            if let url = tab.url { seenURLs.insert(url.absoluteString) }
            tabCount += 1
        }

        // Favorites and bookmarks.
        var markCount = 0
        for mark in state.favorites + state.bookmarks where markCount < 4 && matches(mark.title, mark.url) {
            guard seenURLs.insert(mark.url.absoluteString).inserted else { continue }
            results.append(Suggestion(id: "bm:\(mark.id)", title: mark.title, subtitle: mark.url.absoluteString,
                                      icon: "bookmark", pageURL: mark.url, action: .open(mark.url)))
            markCount += 1
        }

        // History, most recent first.
        var historyCount = 0
        for entry in state.history.reversed() {
            if historyCount >= 6 { break }
            guard matches(entry.title, entry.url), seenURLs.insert(entry.url.absoluteString).inserted else { continue }
            results.append(Suggestion(id: "h:\(entry.id)", title: entry.title.isEmpty ? entry.url.absoluteString : entry.title,
                                      subtitle: entry.url.absoluteString, icon: "clock", pageURL: entry.url,
                                      action: .open(entry.url)))
            historyCount += 1
        }
        return results
    }
}

struct Suggestion: Identifiable {
    enum Action {
        case open(URL)
        case switchTo(BrowserTab)
    }

    let id: String
    let title: String
    let subtitle: String
    let icon: String
    let pageURL: URL?
    let action: Action
    var faviconURL: URL? = nil

    @MainActor
    static func tab(_ tab: BrowserTab) -> Suggestion {
        Suggestion(id: "tab:\(tab.id)", title: tab.displayTitle, subtitle: "Switch to Tab",
                   icon: "square.on.square", pageURL: tab.url, action: .switchTo(tab), faviconURL: tab.faviconURL)
    }
}

private struct SuggestionRow: View {
    let suggestion: Suggestion
    let highlighted: Bool

    var body: some View {
        HStack(spacing: 10) {
            if suggestion.pageURL != nil {
                FaviconView(faviconURL: suggestion.faviconURL, pageURL: suggestion.pageURL, size: 16)
            } else {
                Image(systemName: suggestion.icon)
                    .frame(width: 16)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(suggestion.title)
                    .font(.system(size: 13.5))
                    .lineLimit(1)
                Text(suggestion.subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if case .switchTo = suggestion.action {
                Image(systemName: suggestion.icon)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(highlighted ? Color.accentColor.opacity(0.22) : Color.clear)
        )
        .contentShape(Rectangle())
    }
}

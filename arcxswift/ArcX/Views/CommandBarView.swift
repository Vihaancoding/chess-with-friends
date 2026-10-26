import SwiftUI
import AppKit

/// Spotlight-style command bar (⌘T, ⌘L, ⌘K, ⌘⇧P). One field for URLs, search, open tabs,
/// spaces, bookmarks, history and browser commands, fully keyboard-driven.
/// Results come only from in-memory data — no preview web views are created.
struct CommandBarView: View {
    @EnvironmentObject private var state: BrowserState
    @Environment(\.openWindow) private var openWindow
    let opensNewTab: Bool
    let scope: CommandBarScope

    @State private var text: String
    @State private var highlighted = 0
    @FocusState private var focused: Bool

    init(initialText: String, opensNewTab: Bool, scope: CommandBarScope) {
        self.opensNewTab = opensNewTab
        self.scope = scope
        _text = State(initialValue: initialText)
    }

    var body: some View {
        let groups = buildGroups()
        let flat = groups.flatMap { $0.items }

        ZStack(alignment: .top) {
            Color.black.opacity(0.08)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { state.hideCommandBar() }

            VStack(spacing: 0) {
                HStack(spacing: DS.Spacing.sm) {
                    Image(systemName: scope == .spaces ? "square.stack" : "magnifyingglass")
                        .font(.system(size: 16, weight: .regular))
                        .foregroundStyle(DS.Palette.textTertiary)
                    TextField(placeholder, text: $text)
                        .textFieldStyle(.plain)
                        .font(DS.Font.input)
                        .foregroundStyle(DS.Palette.textPrimary)
                        .focused($focused)
                        .onSubmit { activate(flat, at: highlighted) }
                        .onExitCommand { state.hideCommandBar() }
                        .onKeyPress(.downArrow) {
                            move(1, count: flat.count)
                            return .handled
                        }
                        .onKeyPress(.upArrow) {
                            move(-1, count: flat.count)
                            return .handled
                        }
                    if !text.isEmpty {
                        Button {
                            text = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(DS.Palette.textTertiary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, DS.Spacing.lg)
                .frame(height: 56)

                if !flat.isEmpty {
                    Rectangle()
                        .fill(DS.Palette.hairline)
                        .frame(height: 0.5)
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(groups) { group in
                                    SectionHeader(title: group.section.rawValue)
                                        .padding(.horizontal, DS.Spacing.sm)
                                        .padding(.top, DS.Spacing.sm)
                                        .padding(.bottom, DS.Spacing.xxs)
                                    ForEach(group.items) { item in
                                        let index = flat.firstIndex { $0.id == item.id } ?? 0
                                        CommandRow(item: item, highlighted: index == highlighted)
                                            .id(item.id)
                                            .onTapGesture { activate(flat, at: index) }
                                            .onHover { inside in if inside { highlighted = index } }
                                    }
                                }
                            }
                            .padding(.horizontal, DS.Spacing.xs)
                            .padding(.bottom, DS.Spacing.xs)
                        }
                        .frame(maxHeight: 400)
                        .fixedSize(horizontal: false, vertical: true)
                        .onChange(of: highlighted) {
                            if flat.indices.contains(highlighted) {
                                proxy.scrollTo(flat[highlighted].id)
                            }
                        }
                    }
                }
            }
            .frame(width: 640)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DS.Radius.floating, style: .continuous))
            .background(DS.Palette.floating.opacity(0.5), in: RoundedRectangle(cornerRadius: DS.Radius.floating, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.floating, style: .continuous)
                    .strokeBorder(DS.Palette.hairline, lineWidth: 0.5)
            )
            .shadow(color: DS.Palette.shadow, radius: 28, y: 12)
            .padding(.top, 104)
            .animation(DS.Motion.quick, value: flat.map(\.id))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { focused = true }
        .onChange(of: text) { highlighted = 0 }
    }

    private var placeholder: String {
        switch scope {
        case .spaces: return "Switch to space…"
        case .all: return opensNewTab ? "Search \(SearchEngine.current.name) or enter website" : "Go to website, search or run a command"
        }
    }

    private func move(_ delta: Int, count: Int) {
        guard count > 0 else { return }
        highlighted = (highlighted + delta + count) % count
    }

    private func activate(_ items: [CommandItem], at index: Int) {
        guard !items.isEmpty else {
            state.hideCommandBar()
            return
        }
        let item = items[min(max(index, 0), items.count - 1)]
        state.hideCommandBar()
        switch item.kind {
        case .open(let url):
            state.open(url, inNewTab: opensNewTab)
        case .switchTab(let tab):
            withAnimation(DS.Motion.quick) { state.select(tab) }
        case .switchSpace(let space):
            state.selectSpace(space)
        case .run(let action):
            action()
        }
    }

    // MARK: Results

    private func buildGroups() -> [CommandGroup] {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let needle = query.lowercased()

        if scope == .spaces {
            return [CommandGroup(section: .spaces, items: spaceItems(matching: needle, includeCurrent: true))]
                .filter { !$0.items.isEmpty }
        }

        var groups: [CommandGroup] = []
        var seenURLs = Set<String>()

        if query.isEmpty {
            let recent = (state.currentSpace?.allTabs ?? [])
                .filter { $0 !== state.selectedTab }
                .sorted { $0.lastActive > $1.lastActive }
                .prefix(5)
            groups.append(CommandGroup(section: .tabs, items: recent.map(tabItem)))
            groups.append(CommandGroup(section: .spaces, items: spaceItems(matching: "", includeCurrent: false)))
            groups.append(CommandGroup(section: .commands, items: Array(commandItems(matching: "").prefix(5))))
            return groups.filter { !$0.items.isEmpty }
        }

        // Suggestions
        var suggestions: [CommandItem] = []
        if let url = URLParser.url(from: query) {
            suggestions.append(CommandItem(id: "go:\(url.absoluteString)", section: .suggestions, title: url.absoluteString,
                                           subtitle: "Open website", icon: "arrow.up.right", kind: .open(url)))
            seenURLs.insert(url.absoluteString)
        }
        suggestions.append(CommandItem(id: "search:\(query)", section: .suggestions, title: query,
                                       subtitle: "Search \(SearchEngine.current.name)", icon: "magnifyingglass",
                                       kind: .open(URLParser.searchURL(for: query))))
        groups.append(CommandGroup(section: .suggestions, items: suggestions))

        func matches(_ title: String, _ url: URL?) -> Bool {
            title.lowercased().contains(needle) || (url?.absoluteString.lowercased().contains(needle) ?? false)
        }

        // Open tabs, all spaces.
        let tabs = state.allTabs.filter { matches($0.displayTitle, $0.url) }.prefix(6)
        tabs.forEach { if let url = $0.url { seenURLs.insert(url.absoluteString) } }
        groups.append(CommandGroup(section: .tabs, items: tabs.map(tabItem)))

        groups.append(CommandGroup(section: .spaces, items: spaceItems(matching: needle, includeCurrent: false)))

        // Favorites and bookmarks.
        var marks: [CommandItem] = []
        for mark in state.favorites + state.bookmarks where marks.count < 4 && matches(mark.title, mark.url) {
            guard seenURLs.insert(mark.url.absoluteString).inserted else { continue }
            marks.append(CommandItem(id: "bm:\(mark.id)", section: .bookmarks, title: mark.title,
                                     subtitle: mark.url.host() ?? mark.url.absoluteString, pageURL: mark.url,
                                     kind: .open(mark.url)))
        }
        groups.append(CommandGroup(section: .bookmarks, items: marks))

        // History, most recent first.
        var past: [CommandItem] = []
        for entry in state.history.reversed() {
            if past.count >= 5 { break }
            guard matches(entry.title, entry.url), seenURLs.insert(entry.url.absoluteString).inserted else { continue }
            past.append(CommandItem(id: "h:\(entry.id)", section: .history,
                                    title: entry.title.isEmpty ? entry.url.absoluteString : entry.title,
                                    subtitle: entry.url.host() ?? entry.url.absoluteString, pageURL: entry.url,
                                    kind: .open(entry.url)))
        }
        groups.append(CommandGroup(section: .history, items: past))

        groups.append(CommandGroup(section: .commands, items: Array(commandItems(matching: needle).prefix(6))))
        return groups.filter { !$0.items.isEmpty }
    }

    private func tabItem(_ tab: BrowserTab) -> CommandItem {
        let spaceName = state.space(containing: tab)?.name
        let subtitle = [spaceName, tab.isPinned ? "Pinned" : nil].compactMap { $0 }.joined(separator: " · ")
        return CommandItem(id: "tab:\(tab.id)", section: .tabs, title: tab.displayTitle,
                           subtitle: subtitle.isEmpty ? "Switch to tab" : subtitle,
                           pageURL: tab.url, faviconURL: tab.faviconURL, trailing: "Switch to Tab",
                           kind: .switchTab(tab))
    }

    private func spaceItems(matching needle: String, includeCurrent: Bool) -> [CommandItem] {
        state.spaces.enumerated().compactMap { index, space in
            guard includeCurrent || space.id != state.currentSpace?.id else { return nil }
            guard needle.isEmpty || space.name.lowercased().contains(needle) || "space".contains(needle) else { return nil }
            return CommandItem(id: "space:\(space.id)", section: .spaces, title: space.name,
                               subtitle: "\(space.allTabs.count) tabs", spaceIcon: space.icon, spaceColor: space.color,
                               shortcut: index < 9 ? "⌃\(index + 1)" : nil,
                               kind: .switchSpace(space))
        }
    }

    private func commandItems(matching needle: String) -> [CommandItem] {
        let tab = state.selectedTab
        var commands: [CommandItem] = []

        func add(_ title: String, _ icon: String, _ shortcut: String?, keywords: String = "", enabled: Bool = true,
                 _ action: @escaping () -> Void) {
            guard enabled else { return }
            if !needle.isEmpty && !(title.lowercased().contains(needle) || keywords.contains(needle)) { return }
            commands.append(CommandItem(id: "cmd:\(title)", section: .commands, title: title, subtitle: nil, icon: icon,
                                        shortcut: shortcut, kind: .run(action)))
        }

        add("Reopen Closed Tab", "arrow.uturn.backward", "⇧⌘T", keywords: "undo restore", enabled: !state.closedTabs.isEmpty) {
            state.reopenClosedTab()
        }
        add(state.sidebarVisible ? "Hide Sidebar" : "Show Sidebar", "sidebar.left", "⌘S", keywords: "toggle focus") {
            state.toggleSidebar()
        }
        add(state.splitTabID == nil ? "Open Split View" : "Close Split View", "rectangle.split.2x1", "⌃⇧=",
            keywords: "side by side", enabled: tab != nil) {
            state.toggleSplit()
        }
        if let tab {
            add(tab.isPinned ? "Unpin Tab" : "Pin Tab", tab.isPinned ? "pin.slash" : "pin", "⌘D", keywords: "keep") {
                withAnimation(DS.Motion.standard) { state.togglePin(tab) }
            }
            add("Add to Favorites", "star", nil, keywords: "bookmark") { state.addToFavorites(tab) }
            add("Copy Link", "link", "⇧⌘C", keywords: "url share") { state.copyCurrentLink() }
            add("Find on Page", "doc.text.magnifyingglass", "⌘F", keywords: "search text") { state.showFindBar() }
        }
        add("Switch Space…", "square.stack", "⇧⌘P", keywords: "workspace") {
            Task { @MainActor in state.showCommandBar(newTab: false, scope: .spaces) }
        }
        add("New Space…", "plus.square.on.square", nil, keywords: "workspace create") { state.spaceSheet = .create }
        if let space = state.currentSpace {
            add("Edit Space…", "pencil", nil, keywords: "rename color icon workspace") { state.spaceSheet = .edit(space) }
            add("Clear Today’s Tabs", "xmark.circle", nil, keywords: "close all archive", enabled: !space.tabs.isEmpty) {
                withAnimation(DS.Motion.standard) { state.clearUnpinnedTabs(in: space) }
            }
        }
        add("Show History", "clock", "⌘Y", keywords: "bookmarks archive") { openWindow(id: "history") }
        add("Import from Arc…", "square.and.arrow.down", nil, keywords: "migrate passwords bookmarks") {
            openWindow(id: "arc-import")
        }
        add("Tab Memory", "memorychip", "⌥⌘M", keywords: "debug sleep performance") { openWindow(id: "memory") }
        add("Settings…", "gearshape", "⌘,", keywords: "preferences search engine") {
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        }
        return commands
    }
}

// MARK: - Model

struct CommandItem: Identifiable {
    enum Section: String {
        case suggestions = "Suggestions"
        case tabs = "Tabs"
        case spaces = "Spaces"
        case bookmarks = "Bookmarks"
        case history = "History"
        case commands = "Commands"
    }

    enum Kind {
        case open(URL)
        case switchTab(BrowserTab)
        case switchSpace(Space)
        case run(() -> Void)
    }

    let id: String
    let section: Section
    let title: String
    var subtitle: String?
    var icon: String?
    var pageURL: URL?
    var faviconURL: URL?
    var spaceIcon: String?
    var spaceColor: Color?
    var shortcut: String?
    var trailing: String?
    let kind: Kind
}

struct CommandGroup: Identifiable {
    let section: CommandItem.Section
    let items: [CommandItem]
    var id: String { section.rawValue }
}

private struct CommandRow: View {
    let item: CommandItem
    let highlighted: Bool

    var body: some View {
        HStack(spacing: DS.Spacing.sm) {
            icon
                .frame(width: 18, height: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(DS.Font.body)
                    .foregroundStyle(DS.Palette.textPrimary)
                    .lineLimit(1)
                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .font(DS.Font.secondary)
                        .foregroundStyle(DS.Palette.textSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: DS.Spacing.xs)
            if let shortcut = item.shortcut {
                ShortcutHint(text: shortcut)
            } else if highlighted, let trailing = item.trailing {
                Text(trailing)
                    .font(DS.Font.secondary)
                    .foregroundStyle(DS.Palette.textTertiary)
            }
            if highlighted {
                Image(systemName: "return")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(DS.Palette.textTertiary)
            }
        }
        .padding(.horizontal, DS.Spacing.sm)
        .frame(height: item.subtitle == nil ? 34 : 42)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.item, style: .continuous)
                .fill(highlighted ? DS.Palette.itemSelected : Color.clear)
        )
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var icon: some View {
        if let spaceIcon = item.spaceIcon {
            SpaceIconView(icon: spaceIcon, color: item.spaceColor ?? .accentColor, size: 12)
        } else if item.pageURL != nil {
            FaviconView(faviconURL: item.faviconURL, pageURL: item.pageURL, size: 16)
        } else {
            Image(systemName: item.icon ?? "circle")
                .font(.system(size: 13))
                .foregroundStyle(DS.Palette.textSecondary)
        }
    }
}

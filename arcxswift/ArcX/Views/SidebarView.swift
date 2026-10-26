import SwiftUI
import AppKit

// MARK: - Sidebar

/// The browser's navigation system: toolbar, address field, favorites, the current space's
/// pinned and Today tabs, and the space bar. It recedes visually while you read.
struct SidebarView: View {
    @EnvironmentObject private var state: BrowserState
    @AppStorage("quietSidebar") private var quietSidebar = true
    @State private var hovering = false

    private var isQuiet: Bool {
        quietSidebar && !hovering && state.selectedTab != nil && !state.commandBarVisible
    }

    var body: some View {
        VStack(spacing: 0) {
            SidebarToolbar()
            if let space = state.currentSpace {
                AddressField(tab: space.selectedTab)
                    .padding(.horizontal, DS.Spacing.sm)
                    .padding(.bottom, DS.Spacing.sm)
            }
            if !state.favorites.isEmpty {
                FavoritesGrid()
                    .padding(.horizontal, DS.Spacing.sm)
                    .padding(.bottom, DS.Spacing.sm)
            }
            SpaceSwipeArea(swipe: state.swipe)
            SpaceBar()
        }
        .opacity(isQuiet ? 0.6 : 1)
        .saturation(isQuiet ? 0.4 : 1)
        .animation(hovering ? DS.Motion.quick : .easeInOut(duration: 0.8).delay(1.4), value: isQuiet)
        .onHover { hovering = $0 }
        .onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .global)
        } action: { frame in
            state.swipe.sidebarFrame = frame
        }
        .onDisappear { state.swipe.sidebarFrame = .zero }
    }
}

/// Hosts the space's tab list, follows the trackpad during a swipe and slides between spaces.
private struct SpaceSwipeArea: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var swipe: SpaceSwipeController

    var body: some View {
        ZStack {
            if let space = state.currentSpace {
                SpaceTabList(space: space)
                    .id(space.id)
                    .transition(.asymmetric(
                        insertion: .move(edge: state.spaceTransitionEdge).combined(with: .opacity),
                        removal: .opacity
                    ))
            }
        }
        .offset(x: swipe.offset)
        .opacity(1 - min(0.35, Double(abs(swipe.offset)) / 300))
        .clipped()
        .animation(DS.Motion.space, value: state.currentSpace?.id)
    }
}

// MARK: - Toolbar

private struct SidebarToolbar: View {
    @EnvironmentObject private var state: BrowserState

    var body: some View {
        HStack(spacing: 2) {
            // Room for the window's traffic lights.
            Color.clear.frame(width: 72, height: 1)
            Spacer(minLength: 0)
            ToolbarIconButton(systemName: "sidebar.left", help: "Hide Sidebar  ⌘S") {
                state.toggleSidebar()
            }
            if let tab = state.selectedTab {
                BackForwardButtons(tab: tab)
            } else {
                ToolbarIconButton(systemName: "chevron.left", help: "Back") {}.disabled(true)
                ToolbarIconButton(systemName: "chevron.right", help: "Forward") {}.disabled(true)
            }
        }
        .padding(.horizontal, DS.Spacing.xs)
        .frame(height: 40)
        .background(WindowDragArea())
    }
}

/// Transparent area that lets the window be dragged from toolbar regions.
struct WindowDragArea: View {
    var body: some View {
        Color.clear
            .contentShape(Rectangle())
            .gesture(WindowDragGesture())
    }
}

struct BackForwardButtons: View {
    @ObservedObject var tab: BrowserTab

    var body: some View {
        ToolbarIconButton(systemName: "chevron.left", help: "Back  ⌘[") { tab.webView?.goBack() }
            .disabled(!tab.canGoBack)
        ToolbarIconButton(systemName: "chevron.right", help: "Forward  ⌘]") { tab.webView?.goForward() }
            .disabled(!tab.canGoForward)
    }
}

struct ToolbarIconButton: View {
    let systemName: String
    let help: String
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .regular))
                .frame(width: 28, height: 26)
                .background(
                    RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous)
                        .fill(hovering && isEnabled ? DS.Palette.itemHover : Color.clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isEnabled ? DS.Palette.textSecondary : DS.Palette.textTertiary.opacity(0.5))
        .help(help)
        .onHover { hovering = $0 }
        .animation(DS.Motion.hover, value: hovering)
    }
}

// MARK: - Address field

/// Compact, command-center style address field. Clicking it opens the command bar.
struct AddressField: View {
    @EnvironmentObject private var state: BrowserState
    let tab: BrowserTab?

    var body: some View {
        HStack(spacing: DS.Spacing.xs) {
            Button {
                state.showCommandBar(newTab: false)
            } label: {
                Group {
                    if let tab {
                        AddressLabel(tab: tab)
                    } else {
                        HStack(spacing: 6) {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 11, weight: .medium))
                            Text("Search or enter website")
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(DS.Palette.textTertiary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Search or enter website  ⌘L")

            if let tab {
                ReloadButton(tab: tab)
            }
            MoreMenu()
        }
        .font(.system(size: 12.5))
        .padding(.leading, DS.Spacing.sm)
        .padding(.trailing, DS.Spacing.xxs)
        .frame(height: 32)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.item, style: .continuous)
                .fill(DS.Palette.fill)
        )
    }
}

private struct AddressLabel: View {
    @ObservedObject var tab: BrowserTab

    var body: some View {
        HStack(spacing: 6) {
            if tab.url?.scheme == "https" {
                Image(systemName: "lock.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(DS.Palette.textTertiary)
            }
            Text(displayHost)
                .foregroundStyle(DS.Palette.textPrimary.opacity(0.85))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
            if tab.zoom != 1 {
                Text("\(Int((tab.zoom * 100).rounded()))%")
                    .font(DS.Font.secondary)
                    .foregroundStyle(DS.Palette.textTertiary)
            }
        }
    }

    private var displayHost: String {
        guard let url = tab.url else { return "New Tab" }
        if let host = url.host(), !host.isEmpty {
            return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        }
        return url.absoluteString
    }
}

private struct ReloadButton: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var tab: BrowserTab
    @State private var hovering = false

    var body: some View {
        Button {
            if tab.isLoading { tab.webView?.stopLoading() } else { state.reload(tab) }
        } label: {
            Image(systemName: tab.isLoading ? "xmark" : "arrow.clockwise")
                .font(.system(size: 11, weight: .medium))
                .frame(width: 24, height: 24)
                .background(Circle().fill(hovering ? DS.Palette.itemHover : Color.clear))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(DS.Palette.textSecondary)
        .help(tab.isLoading ? "Stop  ⌘." : "Reload  ⌘R")
        .onHover { hovering = $0 }
    }
}

/// "⋯" menu: secondary actions live here instead of in the toolbar.
struct MoreMenu: View {
    @EnvironmentObject private var state: BrowserState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Menu {
            if let tab = state.selectedTab {
                if let url = tab.url {
                    ShareLink(item: url) { Label("Share…", systemImage: "square.and.arrow.up") }
                }
                Button { state.copyCurrentLink() } label: { Label("Copy Link", systemImage: "link") }
                Divider()
                Button {
                    withAnimation(DS.Motion.standard) { state.togglePin(tab) }
                } label: {
                    Label(tab.isPinned ? "Unpin Tab" : "Pin Tab", systemImage: tab.isPinned ? "pin.slash" : "pin")
                }
                Button { state.addToFavorites(tab) } label: { Label("Add to Favorites", systemImage: "star") }
                Button { state.toggleSplit() } label: {
                    Label(state.splitTabID == nil ? "Open Split View" : "Close Split View", systemImage: "rectangle.split.2x1")
                }
                Divider()
                Button { state.showFindBar() } label: { Label("Find on Page…", systemImage: "magnifyingglass") }
                Menu {
                    Button("Zoom In") { state.zoom(step: 0.1) }
                    Button("Zoom Out") { state.zoom(step: -0.1) }
                    Button("Actual Size") { state.zoom(step: nil) }
                } label: {
                    Label("Zoom", systemImage: "plus.magnifyingglass")
                }
                Divider()
            }
            Button { openWindow(id: "history") } label: { Label("History & Bookmarks", systemImage: "clock") }
            SettingsLink { Label("Settings…", systemImage: "gearshape") }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .medium))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(DS.Palette.textSecondary)
        .help("More")
    }
}

// MARK: - Favorites

private struct FavoritesGrid: View {
    @EnvironmentObject private var state: BrowserState

    private let columns = [GridItem(.adaptive(minimum: 48, maximum: 80), spacing: DS.Spacing.xs)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: DS.Spacing.xs) {
            ForEach(state.favorites) { favorite in
                FavoriteTile(favorite: favorite)
            }
        }
    }
}

private struct FavoriteTile: View {
    @EnvironmentObject private var state: BrowserState
    let favorite: Bookmark
    @State private var hovering = false

    private var isActive: Bool { state.selectedTab?.url == favorite.url }

    var body: some View {
        Button {
            withAnimation(DS.Motion.quick) { state.openFavorite(favorite) }
        } label: {
            FaviconView(faviconURL: nil, pageURL: favorite.url, size: 18)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(
                    RoundedRectangle(cornerRadius: DS.Radius.item, style: .continuous)
                        .fill(isActive ? DS.Palette.itemSelected : (hovering ? DS.Palette.itemHover : DS.Palette.fill))
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(favorite.title)
        .onHover { hovering = $0 }
        .animation(DS.Motion.hover, value: hovering)
        .contextMenu {
            Button { state.newTab(url: favorite.url) } label: { Label("Open in New Tab", systemImage: "plus.square.on.square") }
            Button { copyToPasteboard(favorite.url.absoluteString) } label: { Label("Copy Link", systemImage: "link") }
            ShareLink(item: favorite.url) { Label("Share…", systemImage: "square.and.arrow.up") }
            Divider()
            Button(role: .destructive) { state.removeFavorite(favorite) } label: {
                Label("Remove from Favorites", systemImage: "star.slash")
            }
        }
    }
}

// MARK: - Tab list

/// Drag payload for tabs: "arcx-tab:<uuid>". Plain URLs dropped from elsewhere open as tabs.
enum TabDrag {
    static let prefix = "arcx-tab:"

    static func payload(for tab: BrowserTab) -> String { prefix + tab.id.uuidString }

    static func tabID(from string: String) -> UUID? {
        guard string.hasPrefix(prefix) else { return nil }
        return UUID(uuidString: String(string.dropFirst(prefix.count)))
    }

    /// Handles a drop into `space`'s pinned/Today section before `anchor` (nil = end).
    @MainActor
    static func handle(_ items: [String], state: BrowserState, space: Space, pinned: Bool, before anchor: BrowserTab?) -> Bool {
        guard let item = items.first else { return false }
        if let id = tabID(from: item), let tab = state.tab(withID: id) {
            withAnimation(DS.Motion.standard) {
                state.moveTab(tab, to: space, pinned: pinned, before: anchor)
            }
            return true
        }
        if let url = URLParser.url(from: item), let tab = state.newTab(url: url, in: space, select: false) {
            withAnimation(DS.Motion.standard) {
                state.moveTab(tab, to: space, pinned: pinned, before: anchor)
            }
            return true
        }
        return false
    }
}

private struct SpaceTabList: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var space: Space
    @Namespace private var rows
    @State private var collapsedFolders: Set<String> = []

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                SpaceTitle(space: space)
                    .padding(.horizontal, DS.Spacing.sm)
                    .padding(.bottom, DS.Spacing.sm)

                pinnedSection
                    .padding(.bottom, DS.Spacing.lg)

                todaySection
            }
            .padding(.horizontal, DS.Spacing.xs)
            .padding(.bottom, DS.Spacing.md)
            .animation(DS.Motion.standard, value: space.pinnedTabs.map(\.id))
            .animation(DS.Motion.standard, value: space.tabs.map(\.id))
        }
    }

    // Pinned

    @ViewBuilder
    private var pinnedSection: some View {
        SectionDropHeader(title: "Pinned") { items in
            TabDrag.handle(items, state: state, space: space, pinned: true, before: space.pinnedTabs.first { $0.folder == nil })
        }

        if space.pinnedTabs.isEmpty {
            DropHint(text: "Drag tabs here to keep them") { items in
                TabDrag.handle(items, state: state, space: space, pinned: true, before: nil)
            }
        } else {
            ForEach(space.pinnedTabs.filter { $0.folder == nil }) { tab in
                row(tab, pinned: true)
            }
            ForEach(space.pinnedFolders, id: \.self) { folder in
                FolderRow(name: folder, collapsed: collapsedFolders.contains(folder)) {
                    withAnimation(DS.Motion.standard) {
                        if collapsedFolders.contains(folder) {
                            collapsedFolders.remove(folder)
                        } else {
                            collapsedFolders.insert(folder)
                        }
                    }
                }
                if !collapsedFolders.contains(folder) {
                    ForEach(space.pinnedTabs.filter { $0.folder == folder }) { tab in
                        row(tab, pinned: true)
                            .padding(.leading, DS.Spacing.sm)
                    }
                }
            }
        }
    }

    // Today

    @ViewBuilder
    private var todaySection: some View {
        TodayHeader(space: space) { items in
            TabDrag.handle(items, state: state, space: space, pinned: false, before: space.tabs.first)
        }
        NewTabRow()
        ForEach(space.tabs) { tab in
            row(tab, pinned: false)
        }
        // Dropping below the last tab appends to Today.
        Color.clear
            .frame(height: 44)
            .contentShape(Rectangle())
            .dropDestination(for: String.self) { items, _ in
                TabDrag.handle(items, state: state, space: space, pinned: false, before: nil)
            }
    }

    private func row(_ tab: BrowserTab, pinned: Bool) -> some View {
        TabRow(tab: tab, isSelected: space.selectedTabID == tab.id, isSplitPartner: state.splitTabID == tab.id) { items in
            TabDrag.handle(items, state: state, space: space, pinned: pinned, before: tab)
        }
        .matchedGeometryEffect(id: tab.id, in: rows)
        .transition(.asymmetric(
            insertion: .opacity.combined(with: .move(edge: .top)),
            removal: .opacity.combined(with: .scale(scale: 0.92, anchor: .leading))
        ))
    }
}

/// Workspace selector: current space name with a menu to switch, create or edit spaces.
private struct SpaceTitle: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var space: Space

    var body: some View {
        Menu {
            ForEach(state.spaces) { item in
                Button {
                    state.selectSpace(item)
                } label: {
                    if item.id == space.id {
                        Label(item.name, systemImage: "checkmark")
                    } else {
                        Text(item.name)
                    }
                }
            }
            Divider()
            Button { state.spaceSheet = .create } label: { Label("New Space…", systemImage: "plus") }
            Button { state.spaceSheet = .edit(space) } label: { Label("Edit “\(space.name)”…", systemImage: "pencil") }
        } label: {
            HStack(spacing: 6) {
                SpaceIconView(icon: space.icon, color: space.color, size: 11)
                Text(space.name)
                    .font(DS.Font.title)
                    .foregroundStyle(DS.Palette.textPrimary)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(DS.Palette.textTertiary)
            }
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Switch space  ⌘⇧P · or swipe with two fingers")
    }
}

private struct SectionDropHeader: View {
    let title: String
    let onDrop: ([String]) -> Bool
    @State private var targeted = false

    var body: some View {
        HStack {
            SectionHeader(title: title)
            Spacer()
        }
        .padding(.horizontal, DS.Spacing.xs)
        .frame(height: 24)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous)
                .fill(targeted ? Color.accentColor.opacity(0.12) : Color.clear)
        )
        .contentShape(Rectangle())
        .dropDestination(for: String.self) { items, _ in onDrop(items) } isTargeted: { targeted = $0 }
        .animation(DS.Motion.hover, value: targeted)
    }
}

private struct TodayHeader: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var space: Space
    let onDrop: ([String]) -> Bool
    @State private var targeted = false
    @State private var hovering = false
    @AppStorage(BrowserState.archiveHoursKey) private var archiveHours = BrowserState.defaultArchiveHours

    var body: some View {
        HStack(spacing: DS.Spacing.xs) {
            SectionHeader(title: "Today")
            Spacer()
            if hovering && !space.tabs.isEmpty {
                Button("Clear") {
                    withAnimation(DS.Motion.standard) { state.clearUnpinnedTabs(in: space) }
                }
                .buttonStyle(.plain)
                .font(DS.Font.secondary)
                .foregroundStyle(DS.Palette.textSecondary)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, DS.Spacing.xs)
        .frame(height: 24)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous)
                .fill(targeted ? Color.accentColor.opacity(0.12) : Color.clear)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .help(archiveHelp)
        .dropDestination(for: String.self) { items, _ in onDrop(items) } isTargeted: { targeted = $0 }
        .animation(DS.Motion.hover, value: hovering)
        .animation(DS.Motion.hover, value: targeted)
        .contextMenu {
            Picker("Archive Today Tabs After", selection: $archiveHours) {
                Text("12 Hours").tag(12)
                Text("24 Hours").tag(24)
                Text("7 Days").tag(24 * 7)
                Text("30 Days").tag(24 * 30)
                Text("Never").tag(0)
            }
            Button("Clear Today’s Tabs") {
                withAnimation(DS.Motion.standard) { state.clearUnpinnedTabs(in: space) }
            }
        }
    }

    private var archiveHelp: String {
        guard archiveHours > 0 else { return "Today tabs stay until you close them. Pin a tab to keep it." }
        let period = archiveHours % 24 == 0 ? "\(archiveHours / 24) day\(archiveHours == 24 ? "" : "s")" : "\(archiveHours) hours"
        return "Unused Today tabs are archived after \(period) (History › Archived). Pin a tab to keep it. Right-click to change."
    }
}

private struct DropHint: View {
    let text: String
    let onDrop: ([String]) -> Bool
    @State private var targeted = false

    var body: some View {
        Text(text)
            .font(DS.Font.secondary)
            .foregroundStyle(DS.Palette.textTertiary)
            .frame(maxWidth: .infinity)
            .frame(height: 34)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.item, style: .continuous)
                    .strokeBorder(targeted ? Color.accentColor.opacity(0.6) : DS.Palette.hairline,
                                  style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            )
            .contentShape(Rectangle())
            .dropDestination(for: String.self) { items, _ in onDrop(items) } isTargeted: { targeted = $0 }
            .animation(DS.Motion.hover, value: targeted)
    }
}

private struct FolderRow: View {
    let name: String
    let collapsed: Bool
    let toggle: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: DS.Spacing.xs) {
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .rotationEffect(.degrees(collapsed ? 0 : 90))
                .foregroundStyle(DS.Palette.textTertiary)
                .frame(width: 16)
            Image(systemName: collapsed ? "folder" : "folder.fill")
                .font(.system(size: 12))
                .foregroundStyle(DS.Palette.textSecondary)
            Text(name)
                .font(DS.Font.row)
                .foregroundStyle(DS.Palette.textPrimary.opacity(0.86))
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.item, style: .continuous)
                .fill(hovering ? DS.Palette.itemHover : Color.clear)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: toggle)
        .animation(DS.Motion.hover, value: hovering)
    }
}

private struct NewTabRow: View {
    @EnvironmentObject private var state: BrowserState
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .medium))
                .frame(width: 16)
            Text("New Tab")
                .font(DS.Font.row)
            Spacer()
            if hovering {
                ShortcutHint(text: "⌘T")
            }
        }
        .foregroundStyle(DS.Palette.textSecondary)
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.item, style: .continuous)
                .fill(hovering ? DS.Palette.itemHover : Color.clear)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { state.showCommandBar(newTab: true) }
        .animation(DS.Motion.hover, value: hovering)
    }
}

struct TabRow: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var tab: BrowserTab
    let isSelected: Bool
    let isSplitPartner: Bool
    let onDrop: ([String]) -> Bool
    @State private var hovering = false
    @State private var dropTargeted = false

    var body: some View {
        HStack(spacing: 10) {
            FaviconView(faviconURL: tab.faviconURL, pageURL: tab.url, size: 16)
                .opacity(tab.isAsleep && !isSelected ? 0.6 : 1)
                .saturation(tab.isAsleep && !isSelected ? 0.5 : 1)
            Text(tab.displayTitle)
                .font(isSelected ? DS.Font.rowEmphasized : DS.Font.row)
                .foregroundStyle(isSelected ? DS.Palette.textPrimary : DS.Palette.textPrimary.opacity(0.82))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: DS.Spacing.xxs)
            if isSplitPartner {
                Image(systemName: "rectangle.split.2x1")
                    .font(.system(size: 10))
                    .foregroundStyle(DS.Palette.textTertiary)
            }
            if hovering {
                Button {
                    withAnimation(DS.Motion.standard) { state.closeTab(tab) }
                } label: {
                    Image(systemName: tab.isPinned ? "minus" : "xmark")
                        .font(.system(size: 8.5, weight: .bold))
                        .frame(width: 18, height: 18)
                        .background(Circle().fill(DS.Palette.itemHover))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(DS.Palette.textSecondary)
                .help(tab.isPinned ? "Unload  ⌘W" : "Close  ⌘W")
                .transition(.opacity)
            } else if tab.isLoading {
                ProgressView()
                    .controlSize(.mini)
                    .frame(width: 18, height: 18)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.item, style: .continuous)
                .fill(isSelected ? DS.Palette.itemSelected : (hovering ? DS.Palette.itemHover : Color.clear))
        )
        .overlay(alignment: .top) {
            if dropTargeted {
                Capsule()
                    .fill(Color.accentColor)
                    .frame(height: 2)
                    .padding(.horizontal, 6)
                    .offset(y: -1)
                    .transition(.opacity)
            }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture {
            withAnimation(DS.Motion.quick) { state.select(tab) }
        }
        .draggable(TabDrag.payload(for: tab)) {
            HStack(spacing: 8) {
                FaviconView(faviconURL: tab.faviconURL, pageURL: tab.url, size: 16)
                Text(tab.displayTitle).font(DS.Font.row).lineLimit(1)
            }
            .padding(.horizontal, 12)
            .frame(width: 220, height: 32, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DS.Radius.item, style: .continuous))
        }
        .dropDestination(for: String.self) { items, _ in onDrop(items) } isTargeted: { dropTargeted = $0 }
        .contextMenu { TabContextMenu(tab: tab) }
        .animation(DS.Motion.hover, value: hovering)
        .animation(DS.Motion.quick, value: isSelected)
        .animation(DS.Motion.hover, value: dropTargeted)
    }
}

/// Compact, native context menu with clear groups.
struct TabContextMenu: View {
    @EnvironmentObject private var state: BrowserState
    let tab: BrowserTab

    var body: some View {
        Button {
            withAnimation(DS.Motion.standard) { state.togglePin(tab) }
        } label: {
            Label(tab.isPinned ? "Unpin Tab" : "Pin Tab", systemImage: tab.isPinned ? "pin.slash" : "pin")
        }
        Button { state.addToFavorites(tab) } label: { Label("Add to Favorites", systemImage: "star") }
        if tab !== state.selectedTab, state.space(containing: tab) === state.currentSpace {
            Button { state.openSplit(with: tab) } label: { Label("Open in Split View", systemImage: "rectangle.split.2x1") }
        }
        Menu {
            ForEach(state.spaces.filter { $0 !== state.space(containing: tab) }) { space in
                Button(space.name) {
                    withAnimation(DS.Motion.standard) { state.move(tab, to: space) }
                }
            }
        } label: {
            Label("Move to Space", systemImage: "arrow.right.square")
        }
        Divider()
        Button {
            if let url = tab.url { copyToPasteboard(url.absoluteString) }
        } label: {
            Label("Copy Link", systemImage: "link")
        }
        if let url = tab.url {
            ShareLink(item: url) { Label("Share…", systemImage: "square.and.arrow.up") }
        }
        Button { state.duplicate(tab) } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
        if !tab.isAsleep && !state.isVisible(tab) {
            Button {
                Task { await state.sleepTab(tab) }
            } label: {
                Label("Put to Sleep", systemImage: "moon.zzz")
            }
        }
        Divider()
        Button(role: .destructive) {
            withAnimation(DS.Motion.standard) { state.closeTab(tab) }
        } label: {
            Label(tab.isPinned ? "Unload Tab" : "Close Tab", systemImage: "xmark")
        }
    }
}

func copyToPasteboard(_ string: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
}

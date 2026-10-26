import SwiftUI
import AppKit

struct SidebarView: View {
    @EnvironmentObject private var state: BrowserState

    var body: some View {
        if let space = state.currentSpace {
            SpaceSidebar(space: space)
                .id(space.id)
                .transition(.opacity)
        }
    }
}

private struct SpaceSidebar: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var space: Space
    @State private var expandedFolders: Set<String> = []

    var body: some View {
        VStack(spacing: 8) {
            SidebarHeader()
            AddressPill(tab: space.selectedTab)
                .padding(.horizontal, 10)

            if !state.favorites.isEmpty {
                FavoritesGrid()
                    .padding(.horizontal, 10)
            }

            List {
                if !space.pinnedTabs.isEmpty {
                    Section {
                        ForEach(space.pinnedTabs.filter { $0.folder == nil }) { tab in
                            row(for: tab)
                        }
                        .onMove { source, destination in
                            state.moveLoosePinnedTabs(in: space, from: source, to: destination)
                        }

                        ForEach(space.pinnedFolders, id: \.self) { folder in
                            DisclosureGroup(isExpanded: expansionBinding(for: folder)) {
                                ForEach(space.pinnedTabs.filter { $0.folder == folder }) { tab in
                                    row(for: tab)
                                }
                            } label: {
                                Label(folder, systemImage: "folder")
                                    .font(.system(size: 13))
                                    .lineLimit(1)
                            }
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                        }
                    } header: {
                        Text("Pinned")
                    }
                }

                Section {
                    NewTabRow()
                        .listRowInsets(EdgeInsets(top: 1, leading: 0, bottom: 1, trailing: 0))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)

                    ForEach(space.tabs) { tab in
                        row(for: tab)
                    }
                    .onMove { source, destination in
                        state.moveTabs(in: space, from: source, to: destination)
                    }
                } header: {
                    HStack {
                        Text("Today")
                        Spacer()
                        if !space.tabs.isEmpty {
                            Button("Clear") { state.clearUnpinnedTabs(in: space) }
                                .buttonStyle(.plain)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .help("Close all unpinned tabs (reopen with ⇧⌘T)")
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 28)

            SpaceSwitcher()
        }
        .padding(.bottom, 8)
    }

    private func row(for tab: BrowserTab) -> some View {
        TabRow(tab: tab, isSelected: space.selectedTabID == tab.id || state.splitTabID == tab.id)
            .listRowInsets(EdgeInsets(top: 1, leading: 0, bottom: 1, trailing: 0))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }

    private func expansionBinding(for folder: String) -> Binding<Bool> {
        Binding(
            get: { expandedFolders.contains(folder) },
            set: { expanded in
                if expanded { expandedFolders.insert(folder) } else { expandedFolders.remove(folder) }
            }
        )
    }
}

// MARK: - Header

private struct SidebarHeader: View {
    @EnvironmentObject private var state: BrowserState

    var body: some View {
        HStack(spacing: 2) {
            // Room for the window's traffic-light buttons.
            Color.clear.frame(width: 70, height: 1)
            Spacer(minLength: 0)
            SidebarIconButton(systemName: "sidebar.left", help: "Toggle Sidebar (⌘S)") {
                state.toggleSidebar()
            }
            if let tab = state.selectedTab {
                NavigationButtons(tab: tab)
            } else {
                SidebarIconButton(systemName: "chevron.left", help: "Back") {}.disabled(true)
                SidebarIconButton(systemName: "chevron.right", help: "Forward") {}.disabled(true)
                SidebarIconButton(systemName: "arrow.clockwise", help: "Reload") {}.disabled(true)
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 34)
        .padding(.top, 2)
        .background(
            Color.clear
                .contentShape(Rectangle())
                .gesture(WindowDragGesture())
        )
    }
}

private struct NavigationButtons: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var tab: BrowserTab

    var body: some View {
        SidebarIconButton(systemName: "chevron.left", help: "Back (⌘[)") { tab.webView?.goBack() }
            .disabled(!tab.canGoBack)
        SidebarIconButton(systemName: "chevron.right", help: "Forward (⌘])") { tab.webView?.goForward() }
            .disabled(!tab.canGoForward)
        if tab.isLoading {
            SidebarIconButton(systemName: "xmark", help: "Stop (⌘.)") { tab.webView?.stopLoading() }
        } else {
            SidebarIconButton(systemName: "arrow.clockwise", help: "Reload (⌘R)") { state.reload(tab) }
        }
    }
}

struct SidebarIconButton: View {
    let systemName: String
    let help: String
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .medium))
                .frame(width: 26, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(hovering && isEnabled ? Color.primary.opacity(0.08) : Color.clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isEnabled ? Color.primary.opacity(0.8) : Color.primary.opacity(0.25))
        .help(help)
        .onHover { hovering = $0 }
    }
}

// MARK: - Address pill

private struct AddressPill: View {
    @EnvironmentObject private var state: BrowserState
    let tab: BrowserTab?

    var body: some View {
        Button {
            state.showCommandBar(newTab: false)
        } label: {
            Group {
                if let tab {
                    AddressPillLabel(tab: tab)
                } else {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass")
                        Text("Search or enter URL")
                        Spacer()
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .font(.system(size: 12.5))
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.07)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open Location (⌘L)")
    }
}

private struct AddressPillLabel: View {
    @ObservedObject var tab: BrowserTab

    var body: some View {
        HStack(spacing: 6) {
            if tab.url?.scheme == "https" {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            Text(displayHost)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            if tab.zoom != 1 {
                Text("\(Int((tab.zoom * 100).rounded()))%")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
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

// MARK: - Favorites

private struct FavoritesGrid: View {
    @EnvironmentObject private var state: BrowserState

    private let columns = [GridItem(.adaptive(minimum: 48, maximum: 80), spacing: 6)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 6) {
            ForEach(state.favorites) { favorite in
                Button {
                    state.openFavorite(favorite)
                } label: {
                    FaviconView(faviconURL: nil, pageURL: favorite.url, size: 18)
                        .frame(maxWidth: .infinity)
                        .frame(height: 38)
                        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.primary.opacity(0.07)))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(favorite.title)
                .contextMenu {
                    Button("Open in New Tab") { state.newTab(url: favorite.url) }
                    Button("Copy Link") { copyToPasteboard(favorite.url.absoluteString) }
                    Divider()
                    Button("Remove from Favorites", role: .destructive) { state.removeFavorite(favorite) }
                }
            }
        }
    }
}

// MARK: - Rows

private struct NewTabRow: View {
    @EnvironmentObject private var state: BrowserState
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .semibold))
                .frame(width: 16)
            Text("New Tab")
                .font(.system(size: 13))
            Spacer()
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(hovering ? Color.primary.opacity(0.06) : Color.clear)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { state.showCommandBar(newTab: true) }
    }
}

struct TabRow: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var tab: BrowserTab
    let isSelected: Bool
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            FaviconView(faviconURL: tab.faviconURL, pageURL: tab.url, size: 16)
                .opacity(tab.isAsleep && !isSelected ? 0.55 : 1)
            Text(tab.displayTitle)
                .font(.system(size: 13))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(tab.isAsleep && !isSelected ? Color.primary.opacity(0.6) : Color.primary)
            Spacer(minLength: 4)
            if tab.isLoading {
                ProgressView()
                    .controlSize(.mini)
            }
            if hovering || isSelected {
                Button {
                    state.closeTab(tab)
                } label: {
                    Image(systemName: tab.isPinned ? "minus" : "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .frame(width: 18, height: 18)
                        .background(Circle().fill(Color.primary.opacity(hovering ? 0.08 : 0)))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help(tab.isPinned ? "Unload pinned tab" : "Close tab (⌘W)")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isSelected ? Color.primary.opacity(0.13) : (hovering ? Color.primary.opacity(0.06) : Color.clear))
                .shadow(color: .black.opacity(isSelected ? 0.06 : 0), radius: 1, y: 1)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { state.select(tab) }
        .contextMenu { TabContextMenu(tab: tab) }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .animation(.easeOut(duration: 0.12), value: isSelected)
    }
}

struct TabContextMenu: View {
    @EnvironmentObject private var state: BrowserState
    let tab: BrowserTab

    var body: some View {
        Button(tab.isPinned ? "Unpin Tab" : "Pin Tab") { state.togglePin(tab) }
        Button("Add to Favorites") { state.addToFavorites(tab) }
        if tab !== state.selectedTab {
            Button("Open in Split View") {
                if state.space(containing: tab) !== state.currentSpace {
                    state.select(tab)
                } else {
                    state.openSplit(with: tab)
                }
            }
        }
        Menu("Move to Space") {
            ForEach(state.spaces.filter { $0 !== state.space(containing: tab) }) { space in
                Button(space.name) { state.move(tab, to: space) }
            }
        }
        Divider()
        Button("Copy Link") {
            if let url = tab.url { copyToPasteboard(url.absoluteString) }
        }
        Button("Duplicate Tab") { state.duplicate(tab) }
        if !tab.isAsleep && !state.isVisible(tab) {
            Button("Put Tab to Sleep") {
                Task { await state.sleepTab(tab) }
            }
        }
        Divider()
        Button(tab.isPinned ? "Unload Tab" : "Close Tab", role: .destructive) { state.closeTab(tab) }
    }
}

func copyToPasteboard(_ string: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
}

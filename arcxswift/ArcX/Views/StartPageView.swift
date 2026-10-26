import SwiftUI

/// Calm start page shown when a space has no selected tab. No widgets, no dashboard.
struct StartPageView: View {
    @EnvironmentObject private var state: BrowserState
    @State private var query = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: DS.Spacing.xxxl)

            VStack(spacing: DS.Spacing.xs) {
                Text(greeting)
                    .font(DS.Font.largeTitle)
                    .foregroundStyle(DS.Palette.textPrimary)
                Text("What are you looking for?")
                    .font(.system(size: 15))
                    .foregroundStyle(DS.Palette.textSecondary)
            }
            .padding(.bottom, DS.Spacing.xl)

            HStack(spacing: DS.Spacing.sm) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14))
                    .foregroundStyle(DS.Palette.textTertiary)
                TextField("Search \(SearchEngine.current.name) or enter website", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 15))
                    .focused($focused)
                    .onSubmit(open)
            }
            .padding(.horizontal, DS.Spacing.md)
            .frame(maxWidth: 520)
            .frame(height: 46)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous)
                    .fill(DS.Palette.fill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous)
                    .strokeBorder(focused ? Color.accentColor.opacity(0.45) : DS.Palette.hairline, lineWidth: focused ? 1 : 0.5)
            )
            .animation(DS.Motion.quick, value: focused)
            .padding(.horizontal, DS.Spacing.xxl)

            if state.spaces.count > 1 {
                HStack(spacing: DS.Spacing.xs) {
                    ForEach(state.spaces) { space in
                        SpaceChip(space: space, isCurrent: space.id == state.currentSpace?.id)
                    }
                }
                .padding(.top, DS.Spacing.lg)
            }

            Spacer(minLength: DS.Spacing.xxl)

            destinations
                .padding(.bottom, DS.Spacing.xxxl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, DS.Spacing.xl)
        .onAppear { focused = true }
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        case 17..<22: return "Good evening"
        default: return "Good night"
        }
    }

    private func open() {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        state.open(URLParser.destination(for: trimmed), inNewTab: true)
        query = ""
    }

    @ViewBuilder
    private var destinations: some View {
        let pinned = Array((state.currentSpace?.pinnedTabs ?? []).prefix(6))
        let recent = recentHistory

        if !pinned.isEmpty {
            HStack(spacing: DS.Spacing.lg) {
                ForEach(pinned) { tab in
                    DestinationTile(title: tab.displayTitle, pageURL: tab.url, faviconURL: tab.faviconURL) {
                        withAnimation(DS.Motion.quick) { state.select(tab) }
                    }
                }
            }
            .padding(.bottom, recent.isEmpty ? 0 : DS.Spacing.xl)
        }

        if !recent.isEmpty {
            VStack(alignment: .leading, spacing: DS.Spacing.xxs) {
                SectionHeader(title: "Recent")
                    .padding(.horizontal, DS.Spacing.xs)
                    .padding(.bottom, DS.Spacing.xxs)
                ForEach(recent) { entry in
                    RecentRow(entry: entry) { state.open(entry.url, inNewTab: true) }
                }
            }
            .frame(maxWidth: 420)
        }
    }

    private var recentHistory: [HistoryEntry] {
        var seen = Set<String>()
        var result: [HistoryEntry] = []
        for entry in state.history.reversed() {
            guard let host = entry.url.host(), seen.insert(host).inserted else { continue }
            result.append(entry)
            if result.count == 4 { break }
        }
        return result
    }
}

private struct SpaceChip: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var space: Space
    let isCurrent: Bool
    @State private var hovering = false

    var body: some View {
        Button {
            state.selectSpace(space)
        } label: {
            HStack(spacing: 6) {
                SpaceIconView(icon: space.icon, color: space.color, size: 10)
                Text(space.name)
                    .font(.system(size: 12, weight: isCurrent ? .medium : .regular))
                    .foregroundStyle(isCurrent ? DS.Palette.textPrimary : DS.Palette.textSecondary)
            }
            .padding(.horizontal, DS.Spacing.sm)
            .frame(height: 28)
            .background(
                Capsule().fill(isCurrent ? space.color.opacity(0.14) : (hovering ? DS.Palette.itemHover : Color.clear))
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(DS.Motion.hover, value: hovering)
    }
}

private struct DestinationTile: View {
    let title: String
    let pageURL: URL?
    let faviconURL: URL?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: DS.Spacing.xs) {
                FaviconView(faviconURL: faviconURL, pageURL: pageURL, size: 22)
                    .frame(width: 52, height: 52)
                    .background(
                        RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous)
                            .fill(hovering ? DS.Palette.itemSelected : DS.Palette.fill)
                    )
                    .scaleEffect(hovering ? 1.04 : 1)
                Text(title)
                    .font(.system(size: 11))
                    .foregroundStyle(DS.Palette.textSecondary)
                    .lineLimit(1)
                    .frame(width: 72)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(DS.Motion.hover, value: hovering)
    }
}

private struct RecentRow: View {
    let entry: HistoryEntry
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: DS.Spacing.sm) {
                FaviconView(faviconURL: nil, pageURL: entry.url, size: 14)
                Text(entry.title.isEmpty ? entry.url.absoluteString : entry.title)
                    .font(DS.Font.body)
                    .foregroundStyle(DS.Palette.textPrimary.opacity(0.85))
                    .lineLimit(1)
                Spacer(minLength: DS.Spacing.xs)
                Text(entry.url.host() ?? "")
                    .font(DS.Font.secondary)
                    .foregroundStyle(DS.Palette.textTertiary)
                    .lineLimit(1)
            }
            .padding(.horizontal, DS.Spacing.xs)
            .frame(height: 30)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.item, style: .continuous)
                    .fill(hovering ? DS.Palette.itemHover : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(DS.Motion.hover, value: hovering)
    }
}

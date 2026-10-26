import SwiftUI
import AppKit

enum SpaceSheet: Identifiable {
    case create
    case edit(Space)

    var id: String {
        switch self {
        case .create: return "create"
        case .edit(let space): return space.id.uuidString
        }
    }
}

/// Bottom space bar: downloads, one icon per space (with a sliding active indicator and
/// drop targets for moving tabs between spaces), and "new space".
struct SpaceBar: View {
    @EnvironmentObject private var state: BrowserState
    @EnvironmentObject private var downloads: DownloadManager
    @Namespace private var indicator
    @State private var spaceToDelete: Space?
    @State private var showingDownloads = false

    var body: some View {
        HStack(spacing: DS.Spacing.xxs) {
            ToolbarIconButton(systemName: downloads.hasActiveDownloads ? "arrow.down.circle.fill" : "arrow.down.circle",
                              help: "Downloads") {
                showingDownloads.toggle()
            }
            .popover(isPresented: $showingDownloads, arrowEdge: .top) {
                DownloadsView()
                    .environmentObject(downloads)
            }

            Spacer(minLength: DS.Spacing.xxs)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: DS.Spacing.xxs) {
                    ForEach(Array(state.spaces.enumerated()), id: \.element.id) { index, space in
                        SpaceButton(space: space,
                                    isSelected: space.id == state.currentSpace?.id,
                                    index: index,
                                    indicator: indicator) {
                            state.selectSpace(space)
                        }
                        .contextMenu {
                            Button { state.spaceSheet = .edit(space) } label: { Label("Edit Space…", systemImage: "pencil") }
                            Button {
                                Task { await state.clearWebsiteData(for: space) }
                            } label: {
                                Label("Clear Website Data", systemImage: "trash")
                            }
                            Divider()
                            Button(role: .destructive) { spaceToDelete = space } label: {
                                Label("Delete Space…", systemImage: "minus.circle")
                            }
                            .disabled(state.spaces.count < 2)
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            .fixedSize(horizontal: state.spaces.count <= 6, vertical: false)
            .animation(DS.Motion.space, value: state.currentSpace?.id)

            Spacer(minLength: DS.Spacing.xxs)

            ToolbarIconButton(systemName: "plus", help: "New Space") {
                state.spaceSheet = .create
            }
        }
        .padding(.horizontal, DS.Spacing.xs)
        .padding(.vertical, DS.Spacing.xs)
        .sheet(item: $state.spaceSheet) { sheet in
            SpaceEditorView(sheet: sheet)
                .environmentObject(state)
        }
        .alert("Delete “\(spaceToDelete?.name ?? "")”?", isPresented: Binding(
            get: { spaceToDelete != nil },
            set: { if !$0 { spaceToDelete = nil } }
        )) {
            Button("Delete", role: .destructive) {
                if let space = spaceToDelete { state.deleteSpace(space) }
                spaceToDelete = nil
            }
            Button("Cancel", role: .cancel) { spaceToDelete = nil }
        } message: {
            Text("Its tabs and its cookies and website data will be removed. This can’t be undone.")
        }
    }
}

private struct SpaceButton: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var space: Space
    let isSelected: Bool
    let index: Int
    let indicator: Namespace.ID
    let action: () -> Void
    @State private var hovering = false
    @State private var dropTargeted = false

    var body: some View {
        Button(action: action) {
            SpaceIconView(icon: space.icon, color: isSelected ? space.color : DS.Palette.textSecondary, size: 12)
                .frame(width: 28, height: 28)
                .background {
                    if isSelected {
                        RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous)
                            .fill(space.color.opacity(0.16))
                            .matchedGeometryEffect(id: "active-space", in: indicator)
                    } else if hovering || dropTargeted {
                        RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous)
                            .fill(dropTargeted ? space.color.opacity(0.22) : DS.Palette.itemHover)
                    }
                }
                .scaleEffect(dropTargeted ? 1.12 : 1)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(index < 9 ? "\(space.name)  ⌃\(index + 1)" : space.name)
        .onHover { hovering = $0 }
        .dropDestination(for: String.self) { items, _ in
            TabDrag.handle(items, state: state, space: space, pinned: false, before: space.tabs.first)
        } isTargeted: { dropTargeted = $0 }
        .animation(DS.Motion.hover, value: hovering)
        .animation(DS.Motion.standard, value: dropTargeted)
    }
}

struct SpaceIconView: View {
    let icon: String
    let color: Color
    var size: CGFloat = 13

    var body: some View {
        if SpaceIcon.isSymbol(icon) {
            Image(systemName: icon)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(color)
        } else {
            Text(icon)
                .font(.system(size: size + 1))
        }
    }
}

struct SpaceEditorView: View {
    @EnvironmentObject private var state: BrowserState
    @Environment(\.dismiss) private var dismiss
    let sheet: SpaceSheet

    @State private var name = ""
    @State private var colorHex = Space.palette[0]
    @State private var icon = "circle.fill"
    @State private var emoji = ""

    static let symbols = [
        "person.fill", "briefcase.fill", "house.fill", "star.fill", "heart.fill", "bolt.fill",
        "flame.fill", "leaf.fill", "book.fill", "gamecontroller.fill", "music.note", "cart.fill",
        "graduationcap.fill", "globe", "moon.fill", "sun.max.fill", "paintpalette.fill", "hammer.fill",
        "airplane", "camera.fill", "chart.bar.fill", "terminal.fill", "newspaper.fill", "circle.fill"
    ]

    private var isEditing: Bool {
        if case .edit = sheet { return true }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(isEditing ? "Edit Space" : "New Space")
                .font(.title2.weight(.semibold))

            TextField("Name", text: $name)
                .textFieldStyle(.roundedBorder)

            VStack(alignment: .leading, spacing: 8) {
                Text("Color").font(.subheadline).foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    ForEach(Space.palette, id: \.self) { hex in
                        Circle()
                            .fill(Color(hex: hex) ?? .gray)
                            .frame(width: 22, height: 22)
                            .overlay(Circle().strokeBorder(Color.primary, lineWidth: colorHex == hex ? 2 : 0))
                            .onTapGesture { colorHex = hex }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Icon").font(.subheadline).foregroundStyle(.secondary)
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(30), spacing: 6), count: 8), spacing: 6) {
                    ForEach(Self.symbols, id: \.self) { symbol in
                        Image(systemName: symbol)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color(hex: colorHex) ?? .accentColor)
                            .frame(width: 30, height: 30)
                            .background(
                                RoundedRectangle(cornerRadius: 7)
                                    .fill(icon == symbol && emoji.isEmpty ? Color.primary.opacity(0.14) : Color.primary.opacity(0.04))
                            )
                            .onTapGesture {
                                icon = symbol
                                emoji = ""
                            }
                    }
                }
                HStack {
                    Text("or an emoji:")
                        .foregroundStyle(.secondary)
                    TextField("😀", text: $emoji)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 60)
                }
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(isEditing ? "Save" : "Create") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(22)
        .frame(width: 400)
        .onAppear(perform: load)
    }

    private func load() {
        switch sheet {
        case .create:
            name = ""
            colorHex = Space.palette[state.spaces.count % Space.palette.count]
            icon = "circle.fill"
        case .edit(let space):
            name = space.name
            colorHex = space.colorHex
            if SpaceIcon.isSymbol(space.icon) {
                icon = space.icon
            } else {
                emoji = space.icon
            }
        }
    }

    private func save() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let finalIcon = emoji.isEmpty ? icon : String(emoji.prefix(1))
        switch sheet {
        case .create:
            state.addSpace(name: trimmed, colorHex: colorHex, icon: finalIcon)
        case .edit(let space):
            state.updateSpace(space, name: trimmed, colorHex: colorHex, icon: finalIcon)
        }
        dismiss()
    }
}

struct DownloadsView: View {
    @EnvironmentObject private var downloads: DownloadManager

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Downloads").font(.headline)
                Spacer()
                Button("Clear") { downloads.clearInactive() }
                    .buttonStyle(.borderless)
                    .disabled(downloads.items.allSatisfy { $0.isActive })
            }
            if downloads.items.isEmpty {
                Text("No downloads yet.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 20)
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(downloads.items) { item in
                            DownloadRow(item: item)
                        }
                    }
                }
                .frame(maxHeight: 320)
            }
        }
        .padding(14)
        .frame(width: 340)
    }
}

private struct DownloadRow: View {
    @EnvironmentObject private var downloads: DownloadManager
    @ObservedObject var item: DownloadItem

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc")
                .font(.system(size: 18))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.filename)
                    .lineLimit(1)
                    .truncationMode(.middle)
                switch item.status {
                case .preparing:
                    Text("Preparing…").font(.caption).foregroundStyle(.secondary)
                case .downloading:
                    ProgressView(value: item.fraction)
                        .progressViewStyle(.linear)
                case .finished:
                    Text("Finished").font(.caption).foregroundStyle(.secondary)
                case .failed(let message):
                    Text(message).font(.caption).foregroundStyle(.red).lineLimit(2)
                case .cancelled:
                    Text("Cancelled").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if item.isActive {
                Button {
                    downloads.cancel(item)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .help("Cancel")
            } else if let destination = item.destination, case .finished = item.status {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([destination])
                } label: {
                    Image(systemName: "magnifyingglass.circle.fill")
                }
                .buttonStyle(.borderless)
                .help("Show in Finder")
            }
        }
    }
}

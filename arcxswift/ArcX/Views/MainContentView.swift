import SwiftUI
import AppKit

/// Rounded web content area. Shows one tab, or two tabs side by side in split view.
struct MainContentView: View {
    @EnvironmentObject private var state: BrowserState

    var body: some View {
        VStack(spacing: 0) {
            if state.findBarVisible {
                FindBar()
                    .transition(.move(edge: .top).combined(with: .opacity))
                Rectangle().fill(DS.Palette.hairline).frame(height: 0.5)
            }
            if let space = state.currentSpace {
                SpaceContent(space: space)
            } else {
                StartPageView()
            }
        }
        .background(DS.Palette.content)
        .clipShape(RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous)
                .strokeBorder(DS.Palette.hairline, lineWidth: 0.5)
        )
        .shadow(color: DS.Palette.shadow, radius: 3, y: 1)
        .animation(DS.Motion.quick, value: state.findBarVisible)
    }
}

private struct SpaceContent: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var space: Space

    var body: some View {
        let selected = space.selectedTab
        if let selected, let partner = state.splitTab, partner !== selected {
            SplitContentView(primary: selected, secondary: partner)
        } else if let selected {
            TabPane(tab: selected, showsHeader: false)
                .id(selected.id)
        } else {
            StartPageView()
                .transition(.opacity)
        }
    }
}

/// Split view: two tabs side by side, resizable divider.
struct SplitContentView: View {
    @ObservedObject var primary: BrowserTab
    @ObservedObject var secondary: BrowserTab

    var body: some View {
        HSplitView {
            TabPane(tab: primary, showsHeader: true)
                .frame(minWidth: 280, maxWidth: .infinity)
                .id(primary.id)
            TabPane(tab: secondary, showsHeader: true)
                .frame(minWidth: 280, maxWidth: .infinity)
                .id(secondary.id)
        }
    }
}

struct TabPane: View {
    @EnvironmentObject private var state: BrowserState
    @ObservedObject var tab: BrowserTab
    let showsHeader: Bool

    private var isFocused: Bool { state.selectedTab === tab }

    var body: some View {
        VStack(spacing: 0) {
            if showsHeader {
                HStack(spacing: 8) {
                    FaviconView(faviconURL: tab.faviconURL, pageURL: tab.url, size: 14)
                    Text(tab.displayTitle)
                        .font(.system(size: 12, weight: isFocused ? .semibold : .regular))
                        .lineLimit(1)
                    Spacer()
                    Button {
                        if isFocused {
                            state.closeSplit()
                        } else {
                            state.splitTabID = nil
                        }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .bold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("Close split view")
                }
                .padding(.horizontal, 10)
                .frame(height: 28)
                .background(isFocused ? DS.Palette.itemSelected : DS.Palette.fill.opacity(0.5))
                .contentShape(Rectangle())
                .onTapGesture { state.select(tab) }
                Divider()
            }

            ZStack(alignment: .top) {
                WebViewRepresentable(tab: tab)

                if let snapshot = tab.snapshot, tab.showSnapshotOverlay || tab.webView == nil {
                    Image(nsImage: snapshot)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        .clipped()
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }

                if tab.isLoading {
                    LoadingBar(progress: tab.progress)
                }
            }
            .animation(.easeOut(duration: 0.2), value: tab.showSnapshotOverlay)
        }
        .onAppear { state.wake(tab) }
    }
}

struct LoadingBar: View {
    let progress: Double

    var body: some View {
        GeometryReader { proxy in
            Rectangle()
                .fill(Color.accentColor)
                .frame(width: max(8, proxy.size.width * progress), height: 2)
                .animation(.easeOut(duration: 0.25), value: progress)
        }
        .frame(height: 2)
        .allowsHitTesting(false)
    }
}

struct FindBar: View {
    @EnvironmentObject private var state: BrowserState
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Find on page", text: $state.findText)
                .textFieldStyle(.plain)
                .focused($focused)
                .onSubmit { state.find(backwards: false) }
                .onExitCommand { state.hideFindBar() }
            if state.findNotFound && !state.findText.isEmpty {
                Text("Not found")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            Button { state.find(backwards: true) } label: { Image(systemName: "chevron.up") }
                .buttonStyle(.borderless)
                .help("Previous (⇧⌘G)")
            Button { state.find(backwards: false) } label: { Image(systemName: "chevron.down") }
                .buttonStyle(.borderless)
                .help("Next (⌘G)")
            Button("Done") { state.hideFindBar() }
                .buttonStyle(.borderless)
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(.bar)
        .onAppear { focused = true }
        .onChange(of: state.findFocusToken) { focused = true }
        .onChange(of: state.findText) { state.find(backwards: false, restart: true) }
    }
}

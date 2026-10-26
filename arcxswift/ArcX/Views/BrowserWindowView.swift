import SwiftUI

/// Single unified window: translucent sidebar + rounded content surface.
/// Responsive: wide windows get a full sidebar, medium ones a narrower one, and small
/// windows collapse the sidebar into a hover overlay instead of shrinking everything.
struct BrowserWindowView: View {
    @EnvironmentObject private var state: BrowserState
    @State private var peekingSidebar = false

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let compact = width < 860
            let sidebarWidth: CGFloat = width >= 1240 ? 264 : 236
            let showsSidebar = state.sidebarVisible && !compact

            ZStack(alignment: .topLeading) {
                HStack(spacing: 0) {
                    if showsSidebar {
                        SidebarView()
                            .frame(width: sidebarWidth)
                            .transition(.move(edge: .leading).combined(with: .opacity))
                    }
                    VStack(spacing: 0) {
                        if !showsSidebar {
                            CompactToolbar()
                                .transition(.move(edge: .top).combined(with: .opacity))
                        }
                        MainContentView()
                    }
                    .padding(.top, showsSidebar ? DS.Spacing.xs : 0)
                    .padding(.bottom, DS.Spacing.xs)
                    .padding(.trailing, DS.Spacing.xs)
                    .padding(.leading, showsSidebar ? 0 : DS.Spacing.xs)
                }

                if !showsSidebar {
                    // Hover the left edge to reveal the sidebar as an overlay.
                    Color.clear
                        .frame(width: 6)
                        .frame(maxHeight: .infinity)
                        .contentShape(Rectangle())
                        .onHover { inside in
                            if inside { peekingSidebar = true }
                        }

                    if peekingSidebar {
                        SidebarView()
                            .frame(width: sidebarWidth)
                            .background(VisualEffectBackground(material: .menu, blendingMode: .withinWindow))
                            .clipShape(RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous)
                                    .strokeBorder(DS.Palette.hairline, lineWidth: 0.5)
                            )
                            .shadow(color: DS.Palette.shadow, radius: 20, x: 4)
                            .padding(.vertical, DS.Spacing.xs)
                            .padding(.leading, DS.Spacing.xs)
                            .onHover { inside in
                                if !inside { peekingSidebar = false }
                            }
                            .transition(.move(edge: .leading).combined(with: .opacity))
                    }
                }

                if state.commandBarVisible {
                    CommandBarView(initialText: state.commandBarInitialText,
                                   opensNewTab: state.commandBarOpensNewTab,
                                   scope: state.commandBarScope)
                        .id(state.commandBarToken)
                        .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
                }
            }
            .animation(DS.Motion.standard, value: showsSidebar)
        }
        .background {
            WindowBackground()
                .ignoresSafeArea()
        }
        .ignoresSafeArea()
        .animation(DS.Motion.standard, value: peekingSidebar)
        .animation(DS.Motion.surface, value: state.commandBarVisible)
        .onChange(of: state.sidebarVisible) {
            peekingSidebar = false
        }
        .task {
            state.start()
        }
    }
}

/// Window material with a barely-there wash of the current space's color, so spaces feel
/// like different contexts of the same browser — not different apps.
private struct WindowBackground: View {
    @EnvironmentObject private var state: BrowserState

    var body: some View {
        ZStack {
            VisualEffectBackground(material: .sidebar, blendingMode: .behindWindow)
            if let space = state.currentSpace {
                SpaceTint(space: space)
            }
        }
    }
}

struct SpaceTint: View {
    @ObservedObject var space: Space
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        space.color
            .opacity(colorScheme == .dark ? 0.10 : 0.07)
            .animation(.easeInOut(duration: 0.35), value: space.colorHex)
    }
}

/// Minimal floating toolbar used when the sidebar is hidden or the window is small.
private struct CompactToolbar: View {
    @EnvironmentObject private var state: BrowserState

    var body: some View {
        HStack(spacing: DS.Spacing.xxs) {
            Color.clear.frame(width: 72, height: 1)
            ToolbarIconButton(systemName: "sidebar.left", help: "Show Sidebar  ⌘S") {
                state.toggleSidebar()
            }
            if let tab = state.selectedTab {
                BackForwardButtons(tab: tab)
            }
            Spacer(minLength: DS.Spacing.sm)
            AddressField(tab: state.selectedTab)
                .frame(maxWidth: 460)
            Spacer(minLength: DS.Spacing.sm)
            Color.clear.frame(width: 72 + 28, height: 1)
        }
        .padding(.horizontal, DS.Spacing.xs)
        .frame(height: 44)
        .background(WindowDragArea())
    }
}

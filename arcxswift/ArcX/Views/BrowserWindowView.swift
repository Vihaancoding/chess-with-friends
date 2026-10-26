import SwiftUI

struct BrowserWindowView: View {
    @EnvironmentObject private var state: BrowserState
    @State private var peekingSidebar = false

    var body: some View {
        ZStack(alignment: .leading) {
            HStack(spacing: 0) {
                if state.sidebarVisible {
                    SidebarView()
                        .frame(width: 252)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
                MainContentView()
                    .padding(.top, state.sidebarVisible ? 8 : 30)
                    .padding(.bottom, 8)
                    .padding(.trailing, 8)
                    .padding(.leading, state.sidebarVisible ? 0 : 8)
            }

            if !state.sidebarVisible {
                // Arc-style: hover the left edge to peek at the hidden sidebar.
                Color.clear
                    .frame(width: 8)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .onHover { inside in
                        if inside { peekingSidebar = true }
                    }

                if peekingSidebar {
                    SidebarView()
                        .frame(width: 252)
                        .background(VisualEffectBackground(material: .sidebar, blendingMode: .withinWindow))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .shadow(color: .black.opacity(0.25), radius: 18, x: 4)
                        .padding(.vertical, 8)
                        .padding(.leading, 6)
                        .onHover { inside in
                            if !inside { peekingSidebar = false }
                        }
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
            }

            if state.commandBarVisible {
                CommandBarView(initialText: state.commandBarInitialText, opensNewTab: state.commandBarOpensNewTab)
                    .id(state.commandBarToken)
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
            }
        }
        .background {
            ZStack {
                VisualEffectBackground(material: .sidebar, blendingMode: .behindWindow)
                if let space = state.currentSpace {
                    SpaceTint(space: space)
                }
            }
            .ignoresSafeArea()
        }
        .ignoresSafeArea()
        .animation(.snappy(duration: 0.22), value: state.sidebarVisible)
        .animation(.snappy(duration: 0.18), value: peekingSidebar)
        .animation(.easeOut(duration: 0.15), value: state.commandBarVisible)
        .onChange(of: state.sidebarVisible) {
            peekingSidebar = false
        }
        .task {
            state.start()
        }
    }
}

/// Subtle wash of the current space's color behind the translucent sidebar.
struct SpaceTint: View {
    @ObservedObject var space: Space
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        LinearGradient(
            colors: [
                space.color.opacity(colorScheme == .dark ? 0.28 : 0.22),
                space.color.opacity(colorScheme == .dark ? 0.10 : 0.06)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .animation(.easeInOut(duration: 0.3), value: space.colorHex)
    }
}

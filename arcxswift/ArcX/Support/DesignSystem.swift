import SwiftUI
import AppKit

/// ArcX design tokens. Every spacing, radius, type style, color layer and motion curve
/// used by the UI comes from here so the interface stays consistent.
enum DS {
    /// 4-pt spacing scale.
    enum Spacing {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 20
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
        static let xxxl: CGFloat = 40
    }

    /// Corner radii communicate hierarchy: controls < items < panels < floating surfaces.
    enum Radius {
        static let control: CGFloat = 7
        static let item: CGFloat = 9
        static let panel: CGFloat = 12
        static let floating: CGFloat = 18
    }

    enum Font {
        static let largeTitle = SwiftUI.Font.system(size: 30, weight: .semibold)
        static let title = SwiftUI.Font.system(size: 17, weight: .medium)
        static let sectionHeader = SwiftUI.Font.system(size: 11, weight: .semibold)
        static let row = SwiftUI.Font.system(size: 13)
        static let rowEmphasized = SwiftUI.Font.system(size: 13, weight: .medium)
        static let body = SwiftUI.Font.system(size: 13)
        static let secondary = SwiftUI.Font.system(size: 11.5)
        static let input = SwiftUI.Font.system(size: 19)
        static let shortcut = SwiftUI.Font.system(size: 11, weight: .medium).monospaced()
    }

    /// Layered neutrals. Dark mode is designed, not inverted: no pure black, and each layer
    /// (background → sidebar → content → floating → active item) is a step lighter.
    enum Palette {
        static let content = dynamic(light: NSColor(white: 1.0, alpha: 1), dark: NSColor(white: 0.135, alpha: 1))
        static let floating = dynamic(light: NSColor(white: 0.995, alpha: 0.92), dark: NSColor(white: 0.17, alpha: 0.92))
        static let textPrimary = dynamic(light: NSColor(white: 0.12, alpha: 1), dark: NSColor(white: 0.93, alpha: 1))
        static let textSecondary = dynamic(light: NSColor(white: 0.44, alpha: 1), dark: NSColor(white: 0.62, alpha: 1))
        static let textTertiary = dynamic(light: NSColor(white: 0.62, alpha: 1), dark: NSColor(white: 0.45, alpha: 1))
        static let itemSelected = dynamic(light: NSColor(white: 0, alpha: 0.075), dark: NSColor(white: 1, alpha: 0.10))
        static let itemHover = dynamic(light: NSColor(white: 0, alpha: 0.04), dark: NSColor(white: 1, alpha: 0.055))
        static let fill = dynamic(light: NSColor(white: 0, alpha: 0.05), dark: NSColor(white: 1, alpha: 0.07))
        static let hairline = dynamic(light: NSColor(white: 0, alpha: 0.08), dark: NSColor(white: 1, alpha: 0.08))
        static let shadow = dynamic(light: NSColor(white: 0, alpha: 0.08), dark: NSColor(white: 0, alpha: 0.35))

        private static func dynamic(light: NSColor, dark: NSColor) -> Color {
            Color(nsColor: NSColor(name: nil) { appearance in
                appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            })
        }
    }

    /// Short, system-like motion. Nothing loops; nothing runs while idle.
    enum Motion {
        static let hover = Animation.easeOut(duration: 0.12)
        static let quick = Animation.easeOut(duration: 0.16)
        static let standard = Animation.spring(response: 0.28, dampingFraction: 0.88)
        static let space = Animation.spring(response: 0.32, dampingFraction: 0.9)
        static let surface = Animation.spring(response: 0.26, dampingFraction: 0.86)
    }
}

/// Small rounded label for keyboard shortcuts in menus and the command bar.
struct ShortcutHint: View {
    let text: String

    var body: some View {
        Text(text)
            .font(DS.Font.shortcut)
            .foregroundStyle(DS.Palette.textTertiary)
    }
}

/// Uppercase sidebar/command-bar section header.
struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(DS.Font.sectionHeader)
            .tracking(0.6)
            .foregroundStyle(DS.Palette.textTertiary)
    }
}

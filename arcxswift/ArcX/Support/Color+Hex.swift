import SwiftUI
import AppKit

extension Color {
    /// Parses "#RRGGBB" or "RRGGBB".
    init?(hex: String) {
        let cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
        guard cleaned.count == 6, let value = UInt32(cleaned, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

enum HexColor {
    static func string(red: Double, green: Double, blue: Double) -> String {
        func clamp(_ v: Double) -> Int { Int((min(max(v, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", clamp(red), clamp(green), clamp(blue))
    }
}

enum SpaceIcon {
    /// True when the icon string is a valid SF Symbol name (otherwise it's treated as an emoji).
    static func isSymbol(_ icon: String) -> Bool {
        NSImage(systemSymbolName: icon, accessibilityDescription: nil) != nil
    }

    static func isEmoji(_ icon: String) -> Bool {
        guard let first = icon.unicodeScalars.first else { return false }
        return icon.count <= 2 && (first.properties.isEmojiPresentation || first.properties.isEmoji && first.value > 0x238C)
    }

    static func validated(_ icon: String?) -> String {
        guard let icon, !icon.isEmpty else { return "circle.fill" }
        if isSymbol(icon) || isEmoji(icon) { return icon }
        return "circle.fill"
    }
}

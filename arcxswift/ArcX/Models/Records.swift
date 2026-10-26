import Foundation

/// Codable snapshot of a tab, used for persistence and for "reopen closed tab".
struct TabRecord: Codable, Identifiable, Sendable {
    var id: UUID
    var url: URL?
    var title: String
    var faviconURL: URL?
    var folder: String?
    var scrollY: Double?
    var zoom: Double?
    /// Opaque WebKit session state (back/forward list, scroll, form state).
    var interactionState: Data?
}

struct SpaceRecord: Codable, Identifiable, Sendable {
    var id: UUID
    var name: String
    var colorHex: String
    var icon: String
    var dataStoreID: UUID
    var arcProfile: String?
    var pinned: [TabRecord]
    var tabs: [TabRecord]
    var selectedTabID: UUID?
}

struct SessionRecord: Codable, Sendable {
    var version: Int
    var spaces: [SpaceRecord]
    var selectedSpaceID: UUID?
    var favorites: [Bookmark]
    var sidebarVisible: Bool
}

struct Bookmark: Codable, Identifiable, Hashable, Sendable {
    var id = UUID()
    var title: String
    var url: URL
    var folder: String?
}

struct HistoryEntry: Codable, Identifiable, Hashable, Sendable {
    var id = UUID()
    var url: URL
    var title: String
    var date: Date
}

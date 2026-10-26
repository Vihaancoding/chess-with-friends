import SwiftUI
import WebKit

/// A Space: a name, color, icon, its own tabs and its own persistent website data store.
@MainActor
final class Space: ObservableObject, Identifiable {
    nonisolated static let palette = ["#7C5CFF", "#FF5C8A", "#FF8A3D", "#F5C542", "#3DD68C", "#2EB8E6", "#5C7CFF", "#8E8E93"]

    let id: UUID
    let dataStoreID: UUID

    @Published var name: String
    @Published var colorHex: String
    @Published var icon: String
    @Published var pinnedTabs: [BrowserTab]
    @Published var tabs: [BrowserTab]
    @Published var selectedTabID: UUID?

    /// Arc profile directory this space came from ("Default", "Profile 1", …), if imported.
    var arcProfile: String?

    private var cachedDataStore: WKWebsiteDataStore?

    init(id: UUID = UUID(), name: String, colorHex: String, icon: String, dataStoreID: UUID = UUID(),
         pinnedTabs: [BrowserTab] = [], tabs: [BrowserTab] = [], selectedTabID: UUID? = nil, arcProfile: String? = nil) {
        self.id = id
        self.name = name
        self.colorHex = colorHex
        self.icon = icon
        self.dataStoreID = dataStoreID
        self.pinnedTabs = pinnedTabs
        self.tabs = tabs
        self.selectedTabID = selectedTabID
        self.arcProfile = arcProfile
    }

    convenience init(record: SpaceRecord) {
        self.init(
            id: record.id,
            name: record.name,
            colorHex: record.colorHex,
            icon: record.icon,
            dataStoreID: record.dataStoreID,
            pinnedTabs: record.pinned.map { BrowserTab(record: $0, pinned: true) },
            tabs: record.tabs.map { BrowserTab(record: $0, pinned: false) },
            selectedTabID: record.selectedTabID,
            arcProfile: record.arcProfile
        )
    }

    var record: SpaceRecord {
        SpaceRecord(
            id: id,
            name: name,
            colorHex: colorHex,
            icon: icon,
            dataStoreID: dataStoreID,
            arcProfile: arcProfile,
            pinned: pinnedTabs.map { $0.record },
            tabs: tabs.map { $0.record },
            selectedTabID: selectedTabID
        )
    }

    /// Persistent, isolated cookies/storage for this space (macOS 14+ API).
    var dataStore: WKWebsiteDataStore {
        if let cachedDataStore { return cachedDataStore }
        let store = WKWebsiteDataStore(forIdentifier: dataStoreID)
        cachedDataStore = store
        return store
    }

    func releaseDataStore() {
        cachedDataStore = nil
    }

    var allTabs: [BrowserTab] { pinnedTabs + tabs }

    var selectedTab: BrowserTab? {
        guard let selectedTabID else { return nil }
        return allTabs.first { $0.id == selectedTabID }
    }

    var color: Color { Color(hex: colorHex) ?? .accentColor }

    /// Folder names of pinned tabs, in first-appearance order.
    var pinnedFolders: [String] {
        var seen = Set<String>()
        var result: [String] = []
        for tab in pinnedTabs {
            if let folder = tab.folder, seen.insert(folder).inserted {
                result.append(folder)
            }
        }
        return result
    }
}

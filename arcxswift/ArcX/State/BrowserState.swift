import SwiftUI
import AppKit
import WebKit

struct ClosedTab {
    let record: TabRecord
    let spaceID: UUID
    let index: Int
}

/// Central app state (MVVM view model). All tab/space mutations go through here.
@MainActor
final class BrowserState: ObservableObject {
    @Published var spaces: [Space] = []
    @Published var selectedSpaceID: UUID?
    @Published var favorites: [Bookmark] = []
    @Published private(set) var bookmarks: [Bookmark] = []
    @Published private(set) var history: [HistoryEntry] = []
    @Published var sidebarVisible = true

    @Published var commandBarVisible = false
    @Published private(set) var commandBarOpensNewTab = true
    @Published private(set) var commandBarInitialText = ""
    @Published private(set) var commandBarToken = UUID()

    @Published var findBarVisible = false
    @Published var findText = ""
    @Published var findNotFound = false
    @Published private(set) var findFocusToken = UUID()

    @Published var splitTabID: UUID?
    @Published private(set) var closedTabs: [ClosedTab] = []

    let downloads = DownloadManager()
    let contentBlocker = ContentBlocker()
    let sleepManager = TabSleepManager()

    private var saveWorkItem: DispatchWorkItem?
    private var historyDirty = false
    private var bookmarksDirty = false
    private var started = false

    nonisolated static let pictureInPictureScript = """
    (() => {
      if (document.pictureInPictureElement) { return true; }
      for (const v of document.querySelectorAll('video')) {
        if (v.webkitPresentationMode === 'picture-in-picture') { return true; }
      }
      return false;
    })()
    """

    init() {
        restore()
        downloads.state = self
        sleepManager.state = self
    }

    // MARK: Derived state

    var currentSpace: Space? {
        spaces.first { $0.id == selectedSpaceID } ?? spaces.first
    }

    var selectedTab: BrowserTab? { currentSpace?.selectedTab }

    var splitTab: BrowserTab? {
        guard let splitTabID else { return nil }
        return currentSpace?.allTabs.first { $0.id == splitTabID }
    }

    var allTabs: [BrowserTab] { spaces.flatMap { $0.allTabs } }

    func space(containing tab: BrowserTab) -> Space? {
        spaces.first { space in space.allTabs.contains { $0 === tab } }
    }

    /// A tab is visible when it's the selected tab of the current space or its split partner.
    func isVisible(_ tab: BrowserTab) -> Bool {
        guard let space = currentSpace, space.allTabs.contains(where: { $0 === tab }) else { return false }
        return space.selectedTabID == tab.id || splitTabID == tab.id
    }

    // MARK: Lifecycle

    func start() {
        guard !started else { return }
        started = true
        if let tab = selectedTab { wake(tab) }
        sleepManager.start()
        Task {
            await contentBlocker.load()
            applyContentBlocker()
        }
    }

    private func restore() {
        if let session = Persistence.load(SessionRecord.self, from: Persistence.sessionFile) {
            spaces = session.spaces.map { Space(record: $0) }
            selectedSpaceID = session.selectedSpaceID
            favorites = session.favorites
            sidebarVisible = session.sidebarVisible
        }
        if spaces.isEmpty {
            let space = Space(name: "Personal", colorHex: Space.palette[0], icon: "person.fill")
            spaces = [space]
        }
        if !spaces.contains(where: { $0.id == selectedSpaceID }) {
            selectedSpaceID = spaces.first?.id
        }
        history = Persistence.load([HistoryEntry].self, from: Persistence.historyFile) ?? []
        bookmarks = Persistence.load([Bookmark].self, from: Persistence.bookmarksFile) ?? []
    }

    func scheduleSave() {
        saveWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.saveNow(synchronously: false) }
        }
        saveWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: item)
    }

    func saveNow(synchronously: Bool = true) {
        saveWorkItem?.cancel()
        saveWorkItem = nil
        let session = SessionRecord(
            version: 1,
            spaces: spaces.map { $0.record },
            selectedSpaceID: selectedSpaceID,
            favorites: favorites,
            sidebarVisible: sidebarVisible
        )
        Persistence.save(session, to: Persistence.sessionFile, synchronously: synchronously)
        if historyDirty {
            historyDirty = false
            Persistence.save(history, to: Persistence.historyFile, synchronously: synchronously)
        }
        if bookmarksDirty {
            bookmarksDirty = false
            Persistence.save(bookmarks, to: Persistence.bookmarksFile, synchronously: synchronously)
        }
    }

    // MARK: Web views

    func makeConfiguration(for space: Space) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = space.dataStore
        configuration.allowsAirPlayForMediaPlayback = true
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.preferences.isFraudulentWebsiteWarningEnabled = true
        configuration.defaultWebpagePreferences.preferredContentMode = .desktop
        // Identify as Safari-compatible so sites serve their full WebKit experience.
        configuration.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15"
        if contentBlocker.isEnabled, let list = contentBlocker.ruleList {
            configuration.userContentController.add(list)
        }
        return configuration
    }

    func makeWebView(configuration: WKWebViewConfiguration) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.isInspectable = true
        return webView
    }

    private func install(_ webView: WKWebView, on tab: BrowserTab) {
        tab.attach(webView: webView, controller: WebViewController(tab: tab, state: self))
        webView.pageZoom = tab.zoom
    }

    /// Creates the tab's WKWebView if it is sleeping and restores its session.
    func wake(_ tab: BrowserTab) {
        tab.lastActive = Date()
        guard tab.webView == nil, let space = space(containing: tab) else { return }
        let webView = makeWebView(configuration: makeConfiguration(for: space))
        install(webView, on: tab)
        tab.showSnapshotOverlay = tab.snapshot != nil
        if let saved = tab.savedInteractionState {
            tab.savedInteractionState = nil
            webView.interactionState = saved
        } else if let url = tab.url {
            tab.pendingScrollRestore = tab.scrollY > 0 ? tab.scrollY : nil
            webView.load(URLRequest(url: url))
        } else {
            tab.showSnapshotOverlay = false
        }
    }

    /// Destroys a background tab's WKWebView, keeping URL, title, favicon, scroll position,
    /// session state and a snapshot. Never sleeps visible tabs, tabs playing media,
    /// tabs in Picture in Picture / fullscreen, tabs capturing camera/mic, or downloading tabs.
    @discardableResult
    func sleepTab(_ tab: BrowserTab) async -> Bool {
        guard let webView = tab.webView, !isVisible(tab) else { return false }
        guard await canSleep(tab, webView: webView) else { return false }
        if let y = await evaluateDouble("window.scrollY", in: webView) {
            tab.scrollY = y
        }
        guard tab.webView === webView, !isVisible(tab), tab.activeDownloads == 0 else { return false }
        tab.savedInteractionState = webView.interactionState as? Data
        tab.detachWebView()
        return true
    }

    private func canSleep(_ tab: BrowserTab, webView: WKWebView) async -> Bool {
        if tab.activeDownloads > 0 { return false }
        if webView.cameraCaptureState != WKMediaCaptureState.none { return false }
        if webView.microphoneCaptureState != WKMediaCaptureState.none { return false }
        if webView.fullscreenState != .notInFullscreen { return false }
        let playback: WKMediaPlaybackState = await withCheckedContinuation { continuation in
            webView.requestMediaPlaybackState { continuation.resume(returning: $0) }
        }
        if playback == .playing { return false }
        if await evaluateBool(Self.pictureInPictureScript, in: webView) == true { return false }
        return true
    }

    func evaluateDouble(_ script: String, in webView: WKWebView) async -> Double? {
        await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script, in: nil, in: .defaultClient) { result in
                let value = (try? result.get()) as? Double
                continuation.resume(returning: value)
            }
        }
    }

    func evaluateBool(_ script: String, in webView: WKWebView) async -> Bool? {
        await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script, in: nil, in: .defaultClient) { result in
                let value = (try? result.get()) as? Bool
                continuation.resume(returning: value)
            }
        }
    }

    /// Takes a small JPEG-compressed snapshot while the tab is still on screen.
    func captureSnapshot(of tab: BrowserTab) {
        guard let webView = tab.webView, webView.window != nil, !tab.isLoading else { return }
        let configuration = WKSnapshotConfiguration()
        configuration.snapshotWidth = NSNumber(value: 700)
        webView.takeSnapshot(with: configuration) { [weak tab] image, _ in
            guard let image, let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
            let rep = NSBitmapImageRep(cgImage: cgImage)
            guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else { return }
            Task { @MainActor in
                tab?.setSnapshot(NSImage(data: data), bytes: data.count)
            }
        }
    }

    func applyContentBlocker() {
        guard let list = contentBlocker.ruleList else { return }
        let enabled = contentBlocker.isEnabled
        for tab in allTabs {
            guard let webView = tab.webView else { continue }
            let controller = webView.configuration.userContentController
            controller.remove(list)
            if enabled { controller.add(list) }
        }
    }

    func liveWebViewCount() -> Int {
        allTabs.filter { $0.webView != nil }.count
    }

    // MARK: Tabs

    func select(_ tab: BrowserTab) {
        guard let space = space(containing: tab) else { return }
        let previous = selectedTab
        if let previous, previous !== tab {
            previous.lastActive = Date()
            captureSnapshot(of: previous)
        }
        if selectedSpaceID != space.id {
            selectedSpaceID = space.id
            splitTabID = nil
        }
        if splitTabID == tab.id {
            // Selecting the split partner swaps the panes' roles.
            splitTabID = (previous !== tab) ? previous?.id : nil
        }
        space.selectedTabID = tab.id
        wake(tab)
        scheduleSave()
    }

    @discardableResult
    func newTab(url: URL?, in target: Space? = nil, select shouldSelect: Bool = true) -> BrowserTab? {
        guard let space = target ?? currentSpace else { return nil }
        let tab = BrowserTab(url: url, title: url?.host() ?? "New Tab")
        space.tabs.insert(tab, at: 0)
        if shouldSelect && space === currentSpace {
            select(tab)
        } else {
            wake(tab)
        }
        scheduleSave()
        return tab
    }

    func openInNewTab(_ url: URL, from opener: BrowserTab, select shouldSelect: Bool) {
        newTab(url: url, in: space(containing: opener), select: shouldSelect)
    }

    /// Adopts a WKWebView created by WebKit for window.open / target=_blank.
    func adoptPopup(_ webView: WKWebView, opener: BrowserTab, url: URL?) {
        guard let space = space(containing: opener) ?? currentSpace else { return }
        let tab = BrowserTab(url: url, title: url?.host() ?? "New Tab")
        space.tabs.insert(tab, at: 0)
        install(webView, on: tab)
        select(tab)
        scheduleSave()
    }

    func open(_ url: URL, inNewTab: Bool) {
        if inNewTab || selectedTab == nil {
            newTab(url: url)
        } else if let tab = selectedTab {
            load(url, in: tab)
        }
    }

    func load(_ url: URL, in tab: BrowserTab) {
        tab.url = url
        tab.savedInteractionState = nil
        tab.pendingScrollRestore = nil
        tab.scrollY = 0
        if let webView = tab.webView {
            webView.load(URLRequest(url: url))
        } else {
            tab.setSnapshot(nil, bytes: 0)
            wake(tab)
        }
    }

    func closeSelectedTab() {
        if let tab = selectedTab {
            closeTab(tab)
        } else {
            NSApp.keyWindow?.performClose(nil)
        }
    }

    func closeTab(_ tab: BrowserTab) {
        guard let space = space(containing: tab) else { return }
        let wasSelected = space.selectedTabID == tab.id
        if splitTabID == tab.id { splitTabID = nil }
        var nextIndex = 0

        if tab.isPinned {
            // Like Arc: closing a pinned tab unloads it but keeps it pinned.
            tab.detachWebView()
            tab.setSnapshot(nil, bytes: 0)
        } else {
            let index = space.tabs.firstIndex { $0 === tab } ?? 0
            nextIndex = index
            closedTabs.append(ClosedTab(record: tab.record, spaceID: space.id, index: index))
            if closedTabs.count > 50 { closedTabs.removeFirst() }
            space.tabs.removeAll { $0 === tab }
            tab.detachWebView()
        }

        if wasSelected {
            if !space.tabs.isEmpty {
                let next = space.tabs[min(nextIndex, space.tabs.count - 1)]
                space.selectedTabID = nil
                select(next)
            } else {
                space.selectedTabID = nil
            }
        }
        scheduleSave()
    }

    func clearUnpinnedTabs(in space: Space) {
        let selectedWasUnpinned = space.tabs.contains { $0.id == space.selectedTabID }
        for (index, tab) in space.tabs.enumerated() {
            closedTabs.append(ClosedTab(record: tab.record, spaceID: space.id, index: index))
            if splitTabID == tab.id { splitTabID = nil }
            tab.detachWebView()
        }
        if closedTabs.count > 50 { closedTabs.removeFirst(closedTabs.count - 50) }
        space.tabs = []
        if selectedWasUnpinned { space.selectedTabID = nil }
        scheduleSave()
    }

    func reopenClosedTab() {
        guard let closed = closedTabs.popLast() else { return }
        guard let space = spaces.first(where: { $0.id == closed.spaceID }) ?? currentSpace else { return }
        let tab = BrowserTab(record: closed.record, pinned: false)
        space.tabs.insert(tab, at: min(closed.index, space.tabs.count))
        select(tab)
        scheduleSave()
    }

    func duplicate(_ tab: BrowserTab) {
        guard let url = tab.url else { return }
        newTab(url: url, in: space(containing: tab))
    }

    func togglePin(_ tab: BrowserTab) {
        guard let space = space(containing: tab) else { return }
        if tab.isPinned {
            space.pinnedTabs.removeAll { $0 === tab }
            tab.isPinned = false
            tab.folder = nil
            space.tabs.insert(tab, at: 0)
        } else {
            space.tabs.removeAll { $0 === tab }
            tab.isPinned = true
            space.pinnedTabs.append(tab)
        }
        scheduleSave()
    }

    func moveTabs(in space: Space, from source: IndexSet, to destination: Int) {
        space.tabs.move(fromOffsets: source, toOffset: destination)
        scheduleSave()
    }

    /// Reorders pinned tabs that are not inside a folder.
    func moveLoosePinnedTabs(in space: Space, from source: IndexSet, to destination: Int) {
        var loose = space.pinnedTabs.filter { $0.folder == nil }
        loose.move(fromOffsets: source, toOffset: destination)
        space.pinnedTabs = loose + space.pinnedTabs.filter { $0.folder != nil }
        scheduleSave()
    }

    func move(_ tab: BrowserTab, to target: Space) {
        guard let source = space(containing: tab), source !== target else { return }
        let wasSelected = source.selectedTabID == tab.id
        if splitTabID == tab.id { splitTabID = nil }
        source.pinnedTabs.removeAll { $0 === tab }
        source.tabs.removeAll { $0 === tab }
        if let state = tab.webView?.interactionState as? Data {
            tab.savedInteractionState = state
        }
        // Different space = different website data store, so the web view must be recreated.
        tab.detachWebView()
        tab.isPinned = false
        tab.folder = nil
        target.tabs.insert(tab, at: 0)
        if wasSelected {
            source.selectedTabID = nil
            if let next = source.tabs.first ?? source.pinnedTabs.first, source === currentSpace {
                select(next)
            }
        }
        scheduleSave()
    }

    func selectAdjacentTab(offset: Int) {
        guard let space = currentSpace else { return }
        let ordered = space.allTabs
        guard !ordered.isEmpty else { return }
        let current = ordered.firstIndex { $0.id == space.selectedTabID } ?? 0
        let next = (current + offset + ordered.count) % ordered.count
        select(ordered[next])
    }

    func selectTab(atIndex index: Int) {
        guard let space = currentSpace else { return }
        let ordered = space.allTabs
        guard !ordered.isEmpty else { return }
        // Cmd+9 always selects the last tab, like other browsers.
        let target = index >= 8 ? ordered.count - 1 : min(index, ordered.count - 1)
        select(ordered[target])
    }

    // MARK: Favorites & bookmarks

    func addToFavorites(_ tab: BrowserTab) {
        guard let url = tab.url, !favorites.contains(where: { $0.url == url }) else { return }
        favorites.append(Bookmark(title: tab.displayTitle, url: url))
        scheduleSave()
    }

    func removeFavorite(_ favorite: Bookmark) {
        favorites.removeAll { $0.id == favorite.id }
        scheduleSave()
    }

    func openFavorite(_ favorite: Bookmark) {
        if let existing = currentSpace?.allTabs.first(where: { $0.url?.host() == favorite.url.host() && $0.url == favorite.url }) {
            select(existing)
        } else {
            newTab(url: favorite.url)
        }
    }

    @discardableResult
    func addBookmarks(_ items: [Bookmark]) -> Int {
        var known = Set(bookmarks.map { $0.url.absoluteString })
        var added = 0
        for item in items where known.insert(item.url.absoluteString).inserted {
            bookmarks.append(item)
            added += 1
        }
        if added > 0 {
            bookmarksDirty = true
            scheduleSave()
        }
        return added
    }

    func removeBookmark(_ bookmark: Bookmark) {
        bookmarks.removeAll { $0.id == bookmark.id }
        bookmarksDirty = true
        scheduleSave()
    }

    // MARK: History

    private static let historyLimit = 20_000

    func recordHistory(url: URL, title: String) {
        if let last = history.last, last.url == url, Date().timeIntervalSince(last.date) < 60 {
            if !title.isEmpty && last.title != title {
                history[history.count - 1].title = title
                historyDirty = true
            }
            return
        }
        history.append(HistoryEntry(url: url, title: title, date: Date()))
        if history.count > Self.historyLimit {
            history.removeFirst(history.count - Self.historyLimit)
        }
        historyDirty = true
        scheduleSave()
    }

    @discardableResult
    func mergeHistory(_ entries: [HistoryEntry]) -> Int {
        var known = Set(history.map { "\($0.url.absoluteString)|\(Int($0.date.timeIntervalSince1970))" })
        var added: [HistoryEntry] = []
        for entry in entries where known.insert("\(entry.url.absoluteString)|\(Int(entry.date.timeIntervalSince1970))").inserted {
            added.append(entry)
        }
        guard !added.isEmpty else { return 0 }
        var merged = (history + added).sorted { $0.date < $1.date }
        if merged.count > Self.historyLimit {
            merged.removeFirst(merged.count - Self.historyLimit)
        }
        history = merged
        historyDirty = true
        scheduleSave()
        return added.count
    }

    func clearHistory() {
        history = []
        historyDirty = true
        scheduleSave()
    }

    // MARK: Spaces

    func selectSpace(_ space: Space) {
        guard space.id != selectedSpaceID else { return }
        if let previous = selectedTab {
            previous.lastActive = Date()
            captureSnapshot(of: previous)
        }
        splitTabID = nil
        findBarVisible = false
        selectedSpaceID = space.id
        if let tab = space.selectedTab {
            wake(tab)
        }
        scheduleSave()
    }

    func selectSpace(atIndex index: Int) {
        guard spaces.indices.contains(index) else { return }
        selectSpace(spaces[index])
    }

    @discardableResult
    func addSpace(name: String, colorHex: String, icon: String) -> Space {
        let space = Space(name: name, colorHex: colorHex, icon: icon)
        spaces.append(space)
        selectSpace(space)
        scheduleSave()
        return space
    }

    func updateSpace(_ space: Space, name: String, colorHex: String, icon: String) {
        space.name = name
        space.colorHex = colorHex
        space.icon = icon
        objectWillChange.send()
        scheduleSave()
    }

    func deleteSpace(_ space: Space) {
        guard spaces.count > 1, let index = spaces.firstIndex(where: { $0 === space }) else { return }
        let wasCurrent = currentSpace === space
        for tab in space.allTabs { tab.detachWebView() }
        spaces.remove(at: index)
        if wasCurrent {
            selectedSpaceID = nil
            selectSpace(spaces[max(0, index - 1)])
        }
        let storeID = space.dataStoreID
        space.releaseDataStore()
        scheduleSave()
        Task {
            // Give WebKit a moment to release the store before deleting it from disk.
            try? await Task.sleep(for: .seconds(2))
            try? await WKWebsiteDataStore.remove(forIdentifier: storeID)
        }
    }

    func clearWebsiteData(for space: Space) async {
        let store = space.dataStore
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            store.removeData(ofTypes: types, modifiedSince: .distantPast) {
                continuation.resume()
            }
        }
    }

    /// Website data stores that should receive cookies imported from an Arc profile.
    func dataStores(forArcProfile profile: String) -> [WKWebsiteDataStore] {
        let matching = spaces.filter { $0.arcProfile == profile }
        if !matching.isEmpty { return matching.map { $0.dataStore } }
        if profile == "Default", let current = currentSpace { return [current.dataStore] }
        return []
    }

    // MARK: Split view

    func openSplit(with tab: BrowserTab) {
        guard let space = currentSpace, space.allTabs.contains(where: { $0 === tab }), tab !== selectedTab else { return }
        splitTabID = tab.id
        wake(tab)
    }

    func closeSplit() {
        splitTab?.lastActive = Date()
        splitTabID = nil
    }

    func toggleSplit() {
        if splitTabID != nil {
            closeSplit()
            return
        }
        guard let space = currentSpace, let selected = selectedTab else { return }
        if let partner = space.tabs.first(where: { $0 !== selected }) ?? space.pinnedTabs.first(where: { $0 !== selected }) {
            openSplit(with: partner)
        }
    }

    // MARK: UI commands

    func toggleSidebar() {
        sidebarVisible.toggle()
        scheduleSave()
    }

    func showCommandBar(newTab: Bool) {
        commandBarOpensNewTab = newTab || selectedTab == nil
        commandBarInitialText = commandBarOpensNewTab ? "" : (selectedTab?.url?.absoluteString ?? "")
        commandBarToken = UUID()
        commandBarVisible = true
    }

    func hideCommandBar() {
        commandBarVisible = false
    }

    func goBack() { selectedTab?.webView?.goBack() }
    func goForward() { selectedTab?.webView?.goForward() }
    func stopLoading() { selectedTab?.webView?.stopLoading() }

    func reload(_ tab: BrowserTab? = nil) {
        guard let tab = tab ?? selectedTab else { return }
        if let webView = tab.webView {
            webView.reload()
        } else {
            wake(tab)
        }
    }

    /// `step == nil` resets to 100%.
    func zoom(step: Double?) {
        guard let tab = selectedTab else { return }
        if let step {
            tab.zoom = min(3, max(0.5, ((tab.zoom + step) * 10).rounded() / 10))
        } else {
            tab.zoom = 1
        }
        tab.webView?.pageZoom = tab.zoom
        scheduleSave()
    }

    // MARK: Find on page

    func showFindBar() {
        guard selectedTab != nil else { return }
        findBarVisible = true
        findFocusToken = UUID()
    }

    func hideFindBar() {
        findBarVisible = false
        findNotFound = false
        selectedTab?.webView?.evaluateJavaScript("window.getSelection().removeAllRanges()", in: nil, in: .defaultClient, completionHandler: nil)
    }

    /// `restart` searches from the top of the page (used while typing).
    func find(backwards: Bool, restart: Bool = false) {
        guard let webView = selectedTab?.webView, !findText.isEmpty else {
            findNotFound = false
            return
        }
        let text = findText
        if restart {
            webView.evaluateJavaScript("window.getSelection().removeAllRanges()", in: nil, in: .defaultClient) { [weak self, weak webView] _ in
                Task { @MainActor in
                    guard let self, let webView else { return }
                    self.performFind(text, backwards: backwards, in: webView)
                }
            }
        } else {
            performFind(text, backwards: backwards, in: webView)
        }
    }

    private func performFind(_ text: String, backwards: Bool, in webView: WKWebView) {
        let configuration = WKFindConfiguration()
        configuration.backwards = backwards
        configuration.caseSensitive = false
        configuration.wraps = true
        webView.find(text, configuration: configuration) { [weak self] result in
            let found = result.matchFound
            Task { @MainActor in self?.findNotFound = !found }
        }
    }
}

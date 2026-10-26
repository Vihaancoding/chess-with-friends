import AppKit
import WebKit

/// A browser tab. The `WKWebView` is optional: a sleeping tab keeps only its
/// URL, title, favicon, scroll position, WebKit session state and a small snapshot.
@MainActor
final class BrowserTab: ObservableObject, Identifiable {
    let id: UUID

    @Published var url: URL?
    @Published var title: String
    @Published var faviconURL: URL?
    @Published var isPinned: Bool
    @Published var folder: String?

    @Published var isLoading = false
    @Published var progress: Double = 0
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var zoom: Double = 1

    /// Compressed (JPEG-backed) snapshot shown while the tab sleeps or wakes up.
    @Published var snapshot: NSImage?
    @Published var showSnapshotOverlay = false

    @Published private(set) var webView: WKWebView?

    var scrollY: Double = 0
    var pendingScrollRestore: Double?
    var savedInteractionState: Data?
    var snapshotBytes = 0
    var lastActive = Date()
    var sleptAt: Date?
    var activeDownloads = 0

    private var controller: WebViewController?

    init(id: UUID = UUID(), url: URL?, title: String, faviconURL: URL? = nil, isPinned: Bool = false, folder: String? = nil) {
        self.id = id
        self.url = url
        self.title = title
        self.faviconURL = faviconURL
        self.isPinned = isPinned
        self.folder = folder
        self.sleptAt = Date()
    }

    convenience init(record: TabRecord, pinned: Bool) {
        self.init(id: record.id, url: record.url, title: record.title, faviconURL: record.faviconURL, isPinned: pinned, folder: record.folder)
        scrollY = record.scrollY ?? 0
        zoom = record.zoom ?? 1
        savedInteractionState = record.interactionState
    }

    var record: TabRecord {
        TabRecord(
            id: id,
            url: webView?.url ?? url,
            title: title,
            faviconURL: faviconURL,
            folder: folder,
            scrollY: scrollY > 0 ? scrollY : nil,
            zoom: zoom == 1 ? nil : zoom,
            interactionState: (webView?.interactionState as? Data) ?? savedInteractionState
        )
    }

    var isAsleep: Bool { webView == nil }

    var displayTitle: String {
        if !title.isEmpty { return title }
        return url?.host() ?? "New Tab"
    }

    func attach(webView: WKWebView, controller: WebViewController) {
        detachWebView()
        self.webView = webView
        self.controller = controller
        controller.attach(webView)
        sleptAt = nil
    }

    /// Destroys the web view. Its WebContent process memory is released by WebKit.
    func detachWebView() {
        guard let webView else { return }
        controller?.detach(webView)
        webView.stopLoading()
        webView.removeFromSuperview()
        self.webView = nil
        controller = nil
        isLoading = false
        progress = 0
        sleptAt = Date()
    }

    func setSnapshot(_ image: NSImage?, bytes: Int) {
        snapshot = image
        snapshotBytes = image == nil ? 0 : bytes
    }
}

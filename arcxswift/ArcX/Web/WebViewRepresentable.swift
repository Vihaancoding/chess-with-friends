import SwiftUI
import AppKit
import WebKit

/// Hosts a tab's WKWebView. The web view itself is owned by the tab (so it survives
/// SwiftUI view updates and can be destroyed by the tab sleeper); this view only
/// re-parents it into the visible hierarchy.
struct WebViewRepresentable: NSViewRepresentable {
    @ObservedObject var tab: BrowserTab

    func makeNSView(context: Context) -> WebViewContainer {
        WebViewContainer()
    }

    func updateNSView(_ nsView: WebViewContainer, context: Context) {
        nsView.host(tab.webView)
    }

    static func dismantleNSView(_ nsView: WebViewContainer, coordinator: ()) {
        nsView.host(nil)
    }
}

final class WebViewContainer: NSView {
    private weak var hosted: WKWebView?

    func host(_ webView: WKWebView?) {
        if let webView, hosted === webView, webView.superview === self { return }

        if let hosted, hosted.superview === self {
            hosted.removeFromSuperview()
        }
        hosted = nil

        guard let webView else { return }
        webView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        hosted = webView
        Task { @MainActor [weak webView] in
            guard let webView, let window = webView.window else { return }
            if !(window.firstResponder is NSTextView) {
                window.makeFirstResponder(webView)
            }
        }
    }
}

/// WKNavigationDelegate + WKUIDelegate for one tab. Download delegation is handed to
/// `DownloadManager` (WKDownloadDelegate) as soon as a navigation becomes a download.
@MainActor
final class WebViewController: NSObject, WKNavigationDelegate, WKUIDelegate {
    weak var tab: BrowserTab?
    weak var state: BrowserState?
    private var observations: [NSKeyValueObservation] = []

    private static let allowedSchemes: Set<String> = ["http", "https", "about", "data", "blob", "file", "javascript"]

    private static let faviconScript = """
    (() => {
      const link = document.querySelector("link[rel~='icon'][sizes='32x32'], link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']");
      return link ? link.href : "";
    })()
    """

    init(tab: BrowserTab, state: BrowserState) {
        self.tab = tab
        self.state = state
    }

    func attach(_ webView: WKWebView) {
        webView.navigationDelegate = self
        webView.uiDelegate = self
        observations = [
            webView.observe(\.title, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.sync(view) }
            },
            webView.observe(\.url, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.sync(view) }
            },
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.sync(view) }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.sync(view) }
            },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.sync(view) }
            },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.sync(view) }
            }
        ]
    }

    func detach(_ webView: WKWebView) {
        observations.forEach { $0.invalidate() }
        observations = []
        if webView.navigationDelegate === self { webView.navigationDelegate = nil }
        if webView.uiDelegate === self { webView.uiDelegate = nil }
    }

    private func sync(_ webView: WKWebView) {
        guard let tab, tab.webView === webView else { return }
        if let url = webView.url, tab.url != url { tab.url = url }
        if let title = webView.title, !title.isEmpty, tab.title != title { tab.title = title }
        if tab.isLoading != webView.isLoading { tab.isLoading = webView.isLoading }
        if abs(tab.progress - webView.estimatedProgress) > 0.001 { tab.progress = webView.estimatedProgress }
        if tab.canGoBack != webView.canGoBack { tab.canGoBack = webView.canGoBack }
        if tab.canGoForward != webView.canGoForward { tab.canGoForward = webView.canGoForward }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        if navigationAction.shouldPerformDownload { return .download }
        guard let url = navigationAction.request.url else { return .allow }
        let scheme = url.scheme?.lowercased() ?? ""

        if !Self.allowedSchemes.contains(scheme) {
            // mailto:, tel:, facetime:, app links…
            NSWorkspace.shared.open(url)
            return .cancel
        }

        if navigationAction.navigationType == .linkActivated,
           navigationAction.modifierFlags.contains(.command),
           let tab, let state {
            state.openInNewTab(url, from: tab, select: navigationAction.modifierFlags.contains(.shift))
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if !navigationResponse.canShowMIMEType { return .download }
        if navigationResponse.isForMainFrame,
           let http = navigationResponse.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
           disposition.lowercased().hasPrefix("attachment") {
            return .download
        }
        return .allow
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        state?.downloads.begin(download, tab: tab)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        state?.downloads.begin(download, tab: tab)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        sync(webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        sync(webView)
        guard let tab, let state, tab.webView === webView else { return }
        tab.showSnapshotOverlay = false

        if let url = webView.url, let scheme = url.scheme, scheme == "http" || scheme == "https" {
            state.recordHistory(url: url, title: webView.title ?? "")
        }

        if let y = tab.pendingScrollRestore {
            tab.pendingScrollRestore = nil
            webView.evaluateJavaScript("window.scrollTo(0, \(Int(y)));", in: nil, in: .defaultClient, completionHandler: nil)
        }

        let pageURL = webView.url
        webView.evaluateJavaScript(Self.faviconScript, in: nil, in: .defaultClient) { [weak self] result in
            let href = (try? result.get()) as? String
            Task { @MainActor in self?.applyFavicon(href: href, pageURL: pageURL) }
        }
        state.scheduleSave()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handle(error, in: webView, provisional: true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handle(error, in: webView, provisional: false)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The WebContent process crashed or was killed under memory pressure: reload.
        webView.reload()
    }

    private func handle(_ error: Error, in webView: WKWebView, provisional: Bool) {
        sync(webView)
        tab?.showSnapshotOverlay = false
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        // 102: frame load interrupted (e.g. turned into a download). 204: handled by a plug-in.
        if nsError.domain == "WebKitErrorDomain" && (nsError.code == 102 || nsError.code == 204) { return }
        guard provisional else { return }
        let failingURL = (nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url ?? tab?.url
        webView.loadHTMLString(ErrorPage.html(for: nsError, url: failingURL), baseURL: failingURL)
    }

    private func applyFavicon(href: String?, pageURL: URL?) {
        guard let tab else { return }
        let icon: URL?
        if let href, !href.isEmpty, let url = URL(string: href) {
            icon = url
        } else {
            icon = FaviconStore.fallbackURL(for: pageURL)
        }
        if tab.faviconURL != icon {
            tab.faviconURL = icon
        }
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let state, let tab else { return nil }
        // window.open / target=_blank: WebKit requires us to use the supplied configuration.
        let newWebView = state.makeWebView(configuration: configuration)
        state.adoptPopup(newWebView, opener: tab, url: navigationAction.request.url)
        return newWebView
    }

    func webViewDidClose(_ webView: WKWebView) {
        guard let tab, let state, tab.webView === webView else { return }
        state.closeTab(tab)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = Self.originTitle(frame)
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        _ = await present(alert, for: webView)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = Self.originTitle(frame)
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return await present(alert, for: webView) == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        let alert = NSAlert()
        alert.messageText = Self.originTitle(frame)
        alert.informativeText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let response = await present(alert, for: webView)
        return response == .alertFirstButtonReturn ? field.stringValue : nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        let response: NSApplication.ModalResponse
        if let window = webView.window {
            response = await withCheckedContinuation { continuation in
                panel.beginSheetModal(for: window) { continuation.resume(returning: $0) }
            }
        } else {
            response = panel.runModal()
        }
        return response == .OK ? panel.urls : nil
    }

    private func present(_ alert: NSAlert, for webView: WKWebView) async -> NSApplication.ModalResponse {
        if let window = webView.window {
            return await withCheckedContinuation { continuation in
                alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
            }
        }
        return alert.runModal()
    }

    private static func originTitle(_ frame: WKFrameInfo) -> String {
        let host = frame.securityOrigin.host
        return host.isEmpty ? "This page says" : "\(host) says"
    }
}

enum ErrorPage {
    static func html(for error: NSError, url: URL?) -> String {
        let link = escape(url?.absoluteString ?? "")
        let message = escape(error.localizedDescription)
        return """
        <!doctype html>
        <html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
        <title>Can’t open page</title>
        <style>
        body { font: 15px -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 85vh; color: GrayText; }
        main { max-width: 480px; text-align: center; }
        h1 { font-size: 22px; color: CanvasText; font-weight: 600; }
        a { color: #7C5CFF; }
        code { font-size: 12px; word-break: break-all; }
        </style></head>
        <body><main>
        <h1>ArcX can’t open this page</h1>
        <p>\(message)</p>
        <p><code>\(link)</code></p>
        <p><a href="\(link)">Try again</a></p>
        </main></body></html>
        """
    }

    private static func escape(_ string: String) -> String {
        string
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}

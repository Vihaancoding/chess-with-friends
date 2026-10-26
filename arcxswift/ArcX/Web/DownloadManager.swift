import AppKit
import WebKit

@MainActor
final class DownloadItem: ObservableObject, Identifiable {
    enum Status {
        case preparing
        case downloading
        case finished
        case failed(String)
        case cancelled
    }

    let id = UUID()
    let download: WKDownload
    weak var tab: BrowserTab?

    @Published var filename: String
    @Published var destination: URL?
    @Published var fraction: Double = 0
    @Published var status: Status = .preparing

    var progressObservation: NSKeyValueObservation?
    var countedAsActive = true

    init(download: WKDownload, tab: BrowserTab?) {
        self.download = download
        self.tab = tab
        self.filename = download.originalRequest?.url?.lastPathComponent ?? "Download"
    }

    var isActive: Bool {
        switch status {
        case .preparing, .downloading: return true
        default: return false
        }
    }
}

/// WKDownloadDelegate: saves into ~/Downloads (sandbox "Downloads folder" entitlement).
@MainActor
final class DownloadManager: NSObject, ObservableObject, WKDownloadDelegate {
    @Published private(set) var items: [DownloadItem] = []
    weak var state: BrowserState?

    var hasActiveDownloads: Bool { items.contains { $0.isActive } }

    func begin(_ download: WKDownload, tab: BrowserTab?) {
        download.delegate = self
        let item = DownloadItem(download: download, tab: tab)
        tab?.activeDownloads += 1
        item.progressObservation = download.progress.observe(\.fractionCompleted, options: [.new]) { [weak item] progress, _ in
            let fraction = progress.fractionCompleted
            Task { @MainActor in
                guard let item else { return }
                if fraction - item.fraction >= 0.01 || fraction >= 1 {
                    item.fraction = fraction
                }
            }
        }
        items.insert(item, at: 0)
    }

    func cancel(_ item: DownloadItem) {
        item.download.cancel { _ in }
        item.status = .cancelled
        finish(item)
    }

    func clearInactive() {
        items.removeAll { !$0.isActive }
    }

    private func item(for download: WKDownload) -> DownloadItem? {
        items.first { $0.download === download }
    }

    private func finish(_ item: DownloadItem) {
        item.progressObservation?.invalidate()
        item.progressObservation = nil
        if item.countedAsActive {
            item.countedAsActive = false
            if let tab = item.tab { tab.activeDownloads = max(0, tab.activeDownloads - 1) }
        }
    }

    // MARK: WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        let directory = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let destination = Self.uniqueURL(in: directory, filename: Self.sanitize(suggestedFilename))
        if let item = item(for: download) {
            item.filename = destination.lastPathComponent
            item.destination = destination
            item.status = .downloading
        }
        return destination
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let item = item(for: download) else { return }
        item.fraction = 1
        item.status = .finished
        finish(item)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard let item = item(for: download) else { return }
        if case .cancelled = item.status {
            finish(item)
            return
        }
        item.status = .failed(error.localizedDescription)
        finish(item)
    }

    private static func sanitize(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        return cleaned.isEmpty ? "download" : cleaned
    }

    private static func uniqueURL(in directory: URL, filename: String) -> URL {
        let fm = FileManager.default
        var candidate = directory.appendingPathComponent(filename)
        guard fm.fileExists(atPath: candidate.path) else { return candidate }
        let base = (filename as NSString).deletingPathExtension
        let ext = (filename as NSString).pathExtension
        var counter = 2
        repeat {
            let name = ext.isEmpty ? "\(base) \(counter)" : "\(base) \(counter).\(ext)"
            candidate = directory.appendingPathComponent(name)
            counter += 1
        } while fm.fileExists(atPath: candidate.path)
        return candidate
    }
}

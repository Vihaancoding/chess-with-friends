import SwiftUI
import AppKit

/// Small in-memory favicon cache. Uses URLSession (no extra WKWebViews).
@MainActor
final class FaviconStore {
    static let shared = FaviconStore()

    private let cache = NSCache<NSURL, NSImage>()
    private var inFlight: [URL: Task<NSImage?, Never>] = [:]
    private var failed = Set<URL>()

    private init() {
        cache.countLimit = 400
    }

    func cached(_ url: URL) -> NSImage? {
        cache.object(forKey: url as NSURL)
    }

    func image(for url: URL) async -> NSImage? {
        if let image = cached(url) { return image }
        if failed.contains(url) { return nil }
        if let task = inFlight[url] { return await task.value }

        let task = Task<NSImage?, Never> {
            var request = URLRequest(url: url)
            request.timeoutInterval = 10
            guard let (data, response) = try? await URLSession.shared.data(for: request) else { return nil }
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 { return nil }
            return NSImage(data: data)
        }
        inFlight[url] = task
        let image = await task.value
        inFlight[url] = nil
        if let image {
            cache.setObject(image, forKey: url as NSURL)
        } else {
            failed.insert(url)
        }
        return image
    }

    static func fallbackURL(for pageURL: URL?) -> URL? {
        guard let pageURL, let scheme = pageURL.scheme, scheme.hasPrefix("http"), let host = pageURL.host() else { return nil }
        return URL(string: "\(scheme)://\(host)/favicon.ico")
    }
}

struct FaviconView: View {
    let faviconURL: URL?
    let pageURL: URL?
    var size: CGFloat = 16

    @State private var image: NSImage?

    private var resolvedURL: URL? { faviconURL ?? FaviconStore.fallbackURL(for: pageURL) }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
            } else {
                Image(systemName: "globe")
                    .resizable()
                    .foregroundStyle(.secondary)
            }
        }
        .aspectRatio(contentMode: .fit)
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size / 5, style: .continuous))
        .task(id: resolvedURL) {
            guard let url = resolvedURL else {
                image = nil
                return
            }
            if let cached = FaviconStore.shared.cached(url) {
                image = cached
                return
            }
            let loaded = await FaviconStore.shared.image(for: url)
            if loaded == nil, let fallback = FaviconStore.fallbackURL(for: pageURL), fallback != url {
                image = await FaviconStore.shared.image(for: fallback)
            } else {
                image = loaded
            }
        }
    }
}

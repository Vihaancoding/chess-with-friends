import Foundation

enum SearchEngine: String, CaseIterable, Identifiable {
    case google
    case duckDuckGo
    case bing
    case ecosia

    nonisolated static let defaultsKey = "searchEngine"

    var id: String { rawValue }

    var name: String {
        switch self {
        case .google: return "Google"
        case .duckDuckGo: return "DuckDuckGo"
        case .bing: return "Bing"
        case .ecosia: return "Ecosia"
        }
    }

    /// Google is the default.
    static var current: SearchEngine {
        UserDefaults.standard.string(forKey: defaultsKey).flatMap(SearchEngine.init(rawValue:)) ?? .google
    }

    func url(for query: String) -> URL {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&+=?#")
        let encoded = query.addingPercentEncoding(withAllowedCharacters: allowed) ?? query
        let base: String
        switch self {
        case .google: base = "https://www.google.com/search?q="
        case .duckDuckGo: base = "https://duckduckgo.com/?q="
        case .bing: base = "https://www.bing.com/search?q="
        case .ecosia: base = "https://www.ecosia.org/search?q="
        }
        return URL(string: base + encoded) ?? URL(string: "https://www.google.com/")!
    }
}

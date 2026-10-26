import Foundation

enum URLParser {
    private static let directSchemes: Set<String> = ["http", "https", "file", "about", "data"]

    /// Returns a URL if the input looks like one, otherwise nil (meaning: search).
    static func url(from raw: String) -> URL? {
        let input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return nil }

        if let url = URL(string: input), let scheme = url.scheme?.lowercased(), directSchemes.contains(scheme) {
            if scheme == "http" || scheme == "https" {
                return (url.host()?.isEmpty == false) ? url : nil
            }
            return url
        }

        guard !input.contains(" ") else { return nil }

        guard let candidate = URL(string: "https://" + input), let host = candidate.host(), !host.isEmpty else {
            return nil
        }
        if host == "localhost" || isIPv4(host) {
            return URL(string: "http://" + input)
        }
        let labels = host.split(separator: ".")
        guard labels.count >= 2, let tld = labels.last, tld.count >= 2 else { return nil }
        guard tld.allSatisfy({ $0.isLetter }) || tld.hasPrefix("xn--") else { return nil }
        return candidate
    }

    static func searchURL(for query: String) -> URL {
        SearchEngine.current.url(for: query)
    }

    static func destination(for input: String) -> URL {
        url(from: input) ?? searchURL(for: input.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func isIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".")
        return parts.count == 4 && parts.allSatisfy { part in
            guard let n = Int(part) else { return false }
            return (0...255).contains(n)
        }
    }
}

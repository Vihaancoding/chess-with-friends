import Foundation

/// JSON files in ~/Library/Containers/local.arcx.browser/Data/Library/Application Support/ArcX.
enum Persistence {
    static let sessionFile = "session.json"
    static let historyFile = "history.json"
    static let bookmarksFile = "bookmarks.json"
    static let archiveFile = "archive.json"

    static let directory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ArcX", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()

    private static let writeQueue = DispatchQueue(label: "arcx.persistence", qos: .utility)

    static func load<T: Decodable>(_ type: T.Type, from name: String) -> T? {
        let url = directory.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    static func save<T: Encodable>(_ value: T, to name: String, synchronously: Bool = false) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        let url = directory.appendingPathComponent(name)
        if synchronously {
            writeQueue.sync { try? data.write(to: url, options: .atomic) }
        } else {
            writeQueue.async { try? data.write(to: url, options: .atomic) }
        }
    }
}

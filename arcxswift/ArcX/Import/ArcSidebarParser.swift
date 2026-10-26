import Foundation

struct ParsedArcTab: Sendable {
    var title: String
    var url: URL
    var folder: String?
}

struct ParsedArcSpace: Sendable {
    var id: String
    var name: String
    var colorHex: String?
    var icon: String?
    var profile: String
    var pinned: [ParsedArcTab]
    var unpinned: [ParsedArcTab]
}

struct ParsedArcSidebar: Sendable {
    var spaces: [ParsedArcSpace] = []
    var favorites: [ParsedArcTab] = []
    var skipped: [String: Int] = [:]
    var warnings: [String] = []
}

enum ArcImportError: LocalizedError {
    case unexpectedFormat(String)

    var errorDescription: String? {
        switch self {
        case .unexpectedFormat(let message): return message
        }
    }
}

/// Defensive parser for Arc's StorableSidebar.json. Arc's format is undocumented and
/// changes between versions, so every field is optional and unknown item kinds are counted
/// as skipped instead of failing the import.
struct ArcSidebarParser {
    private var items: [String: [String: Any]] = [:]
    private var visited = Set<String>()
    private var result = ParsedArcSidebar()

    static func parse(contentsOf url: URL) throws -> ParsedArcSidebar {
        let data = try Data(contentsOf: url)
        return try parse(data: data)
    }

    static func parse(data: Data) throws -> ParsedArcSidebar {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw ArcImportError.unexpectedFormat("StorableSidebar.json isn’t valid JSON (\(error.localizedDescription)).")
        }
        guard let root = object as? [String: Any] else {
            throw ArcImportError.unexpectedFormat("StorableSidebar.json has an unexpected top-level structure.")
        }
        var parser = ArcSidebarParser()
        parser.run(root: root)
        return parser.result
    }

    private mutating func run(root: [String: Any]) {
        let containers = Self.findContainers(in: root)
        if containers.isEmpty {
            result.warnings.append("No sidebar containers found — this Arc version may use a newer format.")
            return
        }

        var rawSpaces: [(String, [String: Any])] = []
        var seenSpaceIDs = Set<String>()
        for container in containers {
            for (id, item) in Self.keyedObjects(container["items"]) where items[id] == nil {
                items[id] = item
            }
            for (id, space) in Self.keyedObjects(container["spaces"]) where seenSpaceIDs.insert(id).inserted {
                rawSpaces.append((id, space))
            }
        }

        // Favorites ("top apps") are global in Arc.
        for (id, item) in items.sorted(by: { $0.key < $1.key }) {
            guard let data = item["data"] as? [String: Any],
                  let container = data["itemContainer"] as? [String: Any],
                  let type = container["containerType"] as? [String: Any],
                  type["topApps"] != nil else { continue }
            visited.insert(id)
            var favorites: [ParsedArcTab] = []
            for child in Self.children(of: item) {
                collect(child, path: [], depth: 0, into: &favorites)
            }
            result.favorites.append(contentsOf: favorites.map { ParsedArcTab(title: $0.title, url: $0.url, folder: nil) })
        }

        for (index, entry) in rawSpaces.enumerated() {
            let (spaceID, raw) = entry
            let name = Self.nonEmpty(raw["title"] as? String) ?? "Space \(index + 1)"
            var (pinnedIDs, unpinnedIDs) = Self.containerIDs(of: raw)

            if pinnedIDs.isEmpty && unpinnedIDs.isEmpty {
                // Fallback: find containers that point back at this space.
                for (id, item) in items {
                    guard let data = item["data"] as? [String: Any],
                          let container = data["itemContainer"] as? [String: Any],
                          let type = container["containerType"] as? [String: Any],
                          let spaceItems = type["spaceItems"] as? [String: Any],
                          (spaceItems["_0"] as? String) == spaceID else { continue }
                    pinnedIDs.append(id)
                }
                if pinnedIDs.isEmpty {
                    result.warnings.append("Space “\(name)” has no recognizable tab containers.")
                }
            }

            var pinned: [ParsedArcTab] = []
            for containerID in pinnedIDs {
                guard let container = items[containerID] else {
                    result.warnings.append("Space “\(name)” references a missing pinned container.")
                    continue
                }
                visited.insert(containerID)
                for child in Self.children(of: container) {
                    collect(child, path: [], depth: 0, into: &pinned)
                }
            }

            var unpinned: [ParsedArcTab] = []
            for containerID in unpinnedIDs {
                guard let container = items[containerID] else { continue }
                visited.insert(containerID)
                for child in Self.children(of: container) {
                    collect(child, path: [], depth: 0, into: &unpinned)
                }
            }
            // Folders only make sense for pinned tabs in ArcX; flatten unpinned ones.
            unpinned = unpinned.map { ParsedArcTab(title: $0.title, url: $0.url, folder: nil) }

            let customInfo = raw["customInfo"] as? [String: Any]
            result.spaces.append(ParsedArcSpace(
                id: spaceID,
                name: name,
                colorHex: Self.findColor(customInfo?["windowTheme"]) ?? Self.findColor(customInfo),
                icon: Self.icon(from: customInfo),
                profile: Self.profile(of: raw),
                pinned: pinned,
                unpinned: unpinned
            ))
        }
    }

    private mutating func collect(_ id: String, path: [String], depth: Int, into output: inout [ParsedArcTab]) {
        guard depth < 40, visited.insert(id).inserted, let item = items[id] else { return }
        let data = item["data"] as? [String: Any] ?? [:]

        if let tab = data["tab"] as? [String: Any] {
            let urlString = (tab["savedURL"] as? String) ?? (tab["url"] as? String)
            guard let urlString, let url = URL(string: urlString), url.scheme != nil else {
                result.skipped["Tabs without a usable URL", default: 0] += 1
                return
            }
            let title = Self.nonEmpty(item["title"] as? String)
                ?? Self.nonEmpty(tab["savedTitle"] as? String)
                ?? url.host()
                ?? urlString
            output.append(ParsedArcTab(title: title, url: url, folder: path.isEmpty ? nil : path.joined(separator: " / ")))
        } else if data["list"] != nil {
            let name = Self.nonEmpty(item["title"] as? String) ?? "Folder"
            for child in Self.children(of: item) {
                collect(child, path: path + [name], depth: depth + 1, into: &output)
            }
        } else if data["splitView"] != nil {
            result.skipped["Split views (their tabs were imported individually)", default: 0] += 1
            for child in Self.children(of: item) {
                collect(child, path: path, depth: depth + 1, into: &output)
            }
        } else if data["itemContainer"] != nil {
            for child in Self.children(of: item) {
                collect(child, path: path, depth: depth + 1, into: &output)
            }
        } else {
            let kind = data.keys.sorted().first ?? "unknown"
            result.skipped[Self.label(forKind: kind), default: 0] += 1
        }
    }

    // MARK: Helpers

    private static func findContainers(in root: [String: Any]) -> [[String: Any]] {
        if let sidebar = root["sidebar"] as? [String: Any], let containers = sidebar["containers"] as? [Any] {
            let dicts = containers.compactMap { $0 as? [String: Any] }
            if !dicts.isEmpty { return dicts }
        }
        if let containers = root["containers"] as? [Any] {
            return containers.compactMap { $0 as? [String: Any] }
        }
        if root["spaces"] != nil || root["items"] != nil {
            return [root]
        }
        return []
    }

    /// Arc stores collections either as alternating `["id", {object}, "id", {object}]`
    /// arrays or as dictionaries keyed by id. Accept both.
    static func keyedObjects(_ value: Any?) -> [(String, [String: Any])] {
        var result: [(String, [String: Any])] = []
        if let array = value as? [Any] {
            var pendingID: String?
            for element in array {
                if let id = element as? String {
                    pendingID = id
                } else if let object = element as? [String: Any] {
                    if let id = (object["id"] as? String) ?? pendingID {
                        result.append((id, object))
                    }
                    pendingID = nil
                }
            }
        } else if let dictionary = value as? [String: Any] {
            for key in dictionary.keys.sorted() {
                if let object = dictionary[key] as? [String: Any] {
                    result.append(((object["id"] as? String) ?? key, object))
                }
            }
        }
        return result
    }

    private static func children(of item: [String: Any]) -> [String] {
        (item["childrenIds"] as? [String]) ?? (item["childrenIDs"] as? [String]) ?? []
    }

    private static func containerIDs(of space: [String: Any]) -> (pinned: [String], unpinned: [String]) {
        var pinned: [String] = []
        var unpinned: [String] = []
        for key in ["containerIDs", "newContainerIDs"] {
            guard let array = space[key] as? [Any] else { continue }
            var index = 0
            while index < array.count {
                let marker = array[index]
                let kind = (marker as? String) ?? (marker as? [String: Any])?.keys.first
                if (kind == "pinned" || kind == "unpinned"), index + 1 < array.count, let id = array[index + 1] as? String {
                    if kind == "pinned" {
                        if !pinned.contains(id) { pinned.append(id) }
                    } else if !unpinned.contains(id) {
                        unpinned.append(id)
                    }
                    index += 2
                } else {
                    index += 1
                }
            }
        }
        return (pinned, unpinned)
    }

    private static func profile(of space: [String: Any]) -> String {
        guard let profile = space["profile"] as? [String: Any],
              let custom = profile["custom"] as? [String: Any] else { return "Default" }
        let inner = (custom["_0"] as? [String: Any]) ?? custom
        return nonEmpty(inner["directoryBasename"] as? String) ?? "Default"
    }

    private static func icon(from customInfo: [String: Any]?) -> String? {
        guard let iconType = customInfo?["iconType"] as? [String: Any] else { return nil }
        for key in ["emoji_v2", "emoji"] {
            if let emoji = nonEmpty(iconType[key] as? String) { return emoji }
            if let number = iconType[key] as? NSNumber, let scalar = Unicode.Scalar(number.uint32Value) {
                return String(Character(scalar))
            }
        }
        return nonEmpty(iconType["icon"] as? String)
    }

    /// Depth-first search for the first {red, green, blue} dictionary.
    private static func findColor(_ value: Any?, depth: Int = 0) -> String? {
        guard depth < 14 else { return nil }
        if let dictionary = value as? [String: Any] {
            if let r = number(dictionary["red"]), let g = number(dictionary["green"]), let b = number(dictionary["blue"]) {
                let scale = max(r, g, b) > 1 ? 255.0 : 1.0
                return HexColor.string(red: r / scale, green: g / scale, blue: b / scale)
            }
            for key in dictionary.keys.sorted() {
                if let found = findColor(dictionary[key], depth: depth + 1) { return found }
            }
        } else if let array = value as? [Any] {
            for element in array {
                if let found = findColor(element, depth: depth + 1) { return found }
            }
        }
        return nil
    }

    private static func number(_ value: Any?) -> Double? {
        (value as? NSNumber)?.doubleValue
    }

    static func nonEmpty(_ string: String?) -> String? {
        guard let trimmed = string?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func label(forKind kind: String) -> String {
        switch kind {
        case "easel": return "Easels"
        case "arcDocument", "note", "notes": return "Notes"
        case "space": return "Nested space references"
        default: return "Unsupported sidebar items (“\(kind)”)"
        }
    }
}

/// Parses Chromium's `Bookmarks` JSON file.
enum ChromiumBookmarksParser {
    static func parse(data: Data) throws -> [Bookmark] {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let roots = root["roots"] as? [String: Any] else {
            throw ArcImportError.unexpectedFormat("Bookmarks file has an unexpected structure.")
        }
        var output: [Bookmark] = []
        for key in roots.keys.sorted() {
            walk(roots[key], path: [], depth: 0, into: &output)
        }
        return output
    }

    private static func walk(_ value: Any?, path: [String], depth: Int, into output: inout [Bookmark]) {
        guard depth < 40, let node = value as? [String: Any] else { return }
        let type = node["type"] as? String
        let name = ArcSidebarParser.nonEmpty(node["name"] as? String)
        if type == "url" {
            guard let string = node["url"] as? String, let url = URL(string: string), url.scheme != nil else { return }
            output.append(Bookmark(title: name ?? url.host() ?? string, url: url, folder: path.isEmpty ? nil : path.joined(separator: " / ")))
        } else if let children = node["children"] as? [Any] {
            let childPath = depth == 0 ? path : path + [name ?? "Folder"]
            for child in children {
                walk(child, path: childPath, depth: depth + 1, into: &output)
            }
        }
    }
}

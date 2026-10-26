import AppKit
import WebKit
import UniformTypeIdentifiers

struct ImportReport {
    var imported: [String] = []
    var skipped: [String] = []
    var errors: [String] = []

    var isEmpty: Bool { imported.isEmpty && skipped.isEmpty && errors.isEmpty }
}

/// File › Import from Arc. Reads only what the user explicitly grants via NSOpenPanel
/// (security-scoped access); no sandbox exemptions are assumed.
@MainActor
final class ArcImporter: ObservableObject {
    nonisolated static let notImportable = [
        "Extensions — Chrome extensions can’t run in WKWebView, and WebKit has no public API for third-party browsers to host Safari Web Extensions.",
        "Boosts — Arc-specific CSS/JS page modifications. Re-creating them would require injecting user scripts, which ArcX deliberately avoids.",
        "Easels and Notes — Arc-only document formats with no WebKit equivalent.",
        "Split-view layouts — the tabs are imported individually; re-open split view with ⌃⇧=.",
        "Little Arc, Peek, Air Traffic Control rules, Library media and Arc Max features.",
        "Password autofill — passwords can be imported into the Keychain, but WKWebView offers no public autofill API."
    ]

    @Published var arcFolder: URL?
    @Published var isWorking = false
    @Published var status: String?
    @Published var report = ImportReport()

    @Published var includeSidebar = true
    @Published var includeBookmarks = true
    @Published var includeHistory = true

    /// The user's real home directory (FileManager's home points inside the sandbox container).
    static var realHomeDirectory: URL {
        if let entry = getpwuid(getuid()), let directory = entry.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: directory), isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    // MARK: Folder selection

    func chooseArcFolder() {
        let panel = NSOpenPanel()
        panel.title = "Select Arc’s data folder"
        panel.message = "Select ~/Library/Application Support/Arc so ArcX can read your Arc data. ArcX only reads files inside the folder you choose."
        panel.prompt = "Use This Folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.directoryURL = Self.realHomeDirectory
            .appendingPathComponent("Library/Application Support/Arc", isDirectory: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }

        let fm = FileManager.default
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let hasSidebar = fm.fileExists(atPath: url.appendingPathComponent("StorableSidebar.json").path)
        let hasUserData = fm.fileExists(atPath: url.appendingPathComponent("User Data").path)
        if hasSidebar || hasUserData {
            arcFolder = url
            status = nil
        } else {
            arcFolder = nil
            status = "That folder doesn’t look like Arc’s data folder (no StorableSidebar.json or “User Data”). Choose ~/Library/Application Support/Arc."
        }
    }

    private func profileDirectories(in folder: URL, preferred: [String]) -> [(name: String, url: URL)] {
        let userData = folder.appendingPathComponent("User Data", isDirectory: true)
        var names = ["Default"] + preferred
        if let contents = try? FileManager.default.contentsOfDirectory(atPath: userData.path) {
            names += contents.filter { $0.hasPrefix("Profile ") }.sorted()
        }
        var seen = Set<String>()
        return names.compactMap { name in
            guard seen.insert(name).inserted else { return nil }
            let url = userData.appendingPathComponent(name, isDirectory: true)
            return FileManager.default.fileExists(atPath: url.path) ? (name, url) : nil
        }
    }

    // MARK: Standard import (spaces, tabs, bookmarks, history)

    func runStandardImport(into state: BrowserState) async {
        guard let folder = arcFolder else { return }
        isWorking = true
        report = ImportReport()
        let accessing = folder.startAccessingSecurityScopedResource()
        defer {
            if accessing { folder.stopAccessingSecurityScopedResource() }
            isWorking = false
            status = "Import finished."
        }

        var profiles: [String] = []

        if includeSidebar {
            status = "Reading StorableSidebar.json…"
            let sidebarURL = folder.appendingPathComponent("StorableSidebar.json")
            do {
                let parsed = try await Task.detached(priority: .userInitiated) {
                    try ArcSidebarParser.parse(contentsOf: sidebarURL)
                }.value
                profiles = parsed.spaces.map { $0.profile }
                apply(parsed, to: state)
            } catch {
                report.errors.append("Spaces & tabs: \(error.localizedDescription)")
            }
        }

        let profileDirs = profileDirectories(in: folder, preferred: profiles)

        if includeBookmarks {
            status = "Reading bookmarks…"
            var total: [Bookmark] = []
            for profile in profileDirs {
                let file = profile.url.appendingPathComponent("Bookmarks")
                guard FileManager.default.fileExists(atPath: file.path) else { continue }
                do {
                    let items = try await Task.detached(priority: .userInitiated) {
                        try ChromiumBookmarksParser.parse(data: Data(contentsOf: file))
                    }.value
                    total += items
                } catch {
                    report.errors.append("Bookmarks (\(profile.name)): \(error.localizedDescription)")
                }
            }
            let added = state.addBookmarks(total)
            report.imported.append("Bookmarks: \(added) added (\(total.count - added) duplicates skipped)")
        }

        if includeHistory {
            status = "Reading history (copying the database first, since Arc may be running)…"
            var entries: [HistoryEntry] = []
            for profile in profileDirs {
                let file = profile.url.appendingPathComponent("History")
                guard FileManager.default.fileExists(atPath: file.path) else { continue }
                do {
                    entries += try await Task.detached(priority: .userInitiated) {
                        try Self.readHistory(at: file)
                    }.value
                } catch {
                    report.errors.append("History (\(profile.name)): \(error.localizedDescription)")
                }
            }
            let added = state.mergeHistory(entries)
            report.imported.append("History: \(added) entries added")
        }

        state.saveNow(synchronously: false)
    }

    private func apply(_ parsed: ParsedArcSidebar, to state: BrowserState) {
        var createdSpaces = 0
        var mergedSpaces = 0
        var pinnedCount = 0
        var openCount = 0
        var folders = Set<String>()

        for parsedSpace in parsed.spaces {
            let space: Space
            if let existing = state.spaces.first(where: { $0.name.caseInsensitiveCompare(parsedSpace.name) == .orderedSame }) {
                space = existing
                mergedSpaces += 1
            } else {
                let color = parsedSpace.colorHex ?? Space.palette[(state.spaces.count) % Space.palette.count]
                space = Space(name: parsedSpace.name, colorHex: color, icon: SpaceIcon.validated(parsedSpace.icon))
                state.spaces.append(space)
                createdSpaces += 1
            }
            if space.arcProfile == nil { space.arcProfile = parsedSpace.profile }

            var known = Set(space.allTabs.compactMap { $0.url?.absoluteString })
            for tab in parsedSpace.pinned where known.insert(tab.url.absoluteString).inserted {
                space.pinnedTabs.append(BrowserTab(url: tab.url, title: tab.title, isPinned: true, folder: tab.folder))
                if let folder = tab.folder { folders.insert("\(space.id)/\(folder)") }
                pinnedCount += 1
            }
            for tab in parsedSpace.unpinned where known.insert(tab.url.absoluteString).inserted {
                space.tabs.append(BrowserTab(url: tab.url, title: tab.title))
                openCount += 1
            }
        }

        var favoritesAdded = 0
        for favorite in parsed.favorites where !state.favorites.contains(where: { $0.url == favorite.url }) {
            state.favorites.append(Bookmark(title: favorite.title, url: favorite.url))
            favoritesAdded += 1
        }

        // Remove the untouched default space if Arc spaces replaced it.
        if createdSpaces > 0, let placeholder = state.spaces.first,
           placeholder.name == "Personal", placeholder.allTabs.isEmpty, state.spaces.count > 1,
           !parsed.spaces.contains(where: { $0.name.caseInsensitiveCompare("Personal") == .orderedSame }) {
            state.deleteSpace(placeholder)
        }

        report.imported.append("Spaces: \(createdSpaces) created, \(mergedSpaces) merged into existing spaces")
        report.imported.append("Pinned tabs: \(pinnedCount) (in \(folders.count) folders)")
        report.imported.append("Open (unpinned) tabs: \(openCount)")
        report.imported.append("Favorites: \(favoritesAdded)")
        for (kind, count) in parsed.skipped.sorted(by: { $0.key < $1.key }) {
            report.skipped.append("\(kind): \(count)")
        }
        report.skipped.append(contentsOf: parsed.warnings)
        state.objectWillChange.send()
        state.scheduleSave()
    }

    nonisolated private static func readHistory(at file: URL) throws -> [HistoryEntry] {
        let copy = try ChromiumFiles.copyDatabase(file)
        defer { try? FileManager.default.removeItem(at: copy.directory) }
        let database = try SQLiteDatabase(path: copy.file.path)
        var entries: [HistoryEntry] = []
        let handler: (SQLiteRow) -> Void = { row in
            guard let string = row.string(0), let url = URL(string: string),
                  let scheme = url.scheme, scheme == "http" || scheme == "https",
                  let date = ChromiumFiles.date(fromChromeTime: row.int64(2)) else { return }
            entries.append(HistoryEntry(url: url, title: row.string(1) ?? "", date: date))
        }
        do {
            try database.query("SELECT url, title, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT 10000", row: handler)
        } catch {
            entries.removeAll()
            try database.query("SELECT url, title, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT 10000", row: handler)
        }
        return entries
    }

    // MARK: Sensitive import (passwords & cookies)

    func runSensitiveImport(into state: BrowserState, passwords: Bool, cookies: Bool) async {
        guard let folder = arcFolder, passwords || cookies else { return }
        isWorking = true
        report = ImportReport()
        let accessing = folder.startAccessingSecurityScopedResource()
        defer {
            if accessing { folder.stopAccessingSecurityScopedResource() }
            isWorking = false
            status = "Import finished."
        }

        status = "Waiting for Keychain permission (“Arc Safe Storage”)…"
        let secretResult: Result<Data, Error> = await Task.detached(priority: .userInitiated) {
            Result { try KeychainStore.readGenericPassword(service: "Arc Safe Storage") }
        }.value

        let decryptor: ChromiumDecryptor
        switch secretResult {
        case .success(let secret):
            guard let made = ChromiumDecryptor(safeStoragePassword: secret) else {
                report.errors.append("Couldn’t derive the decryption key from “Arc Safe Storage”.")
                return
            }
            decryptor = made
        case .failure(let error):
            report.errors.append("Couldn’t read “Arc Safe Storage” from the Keychain: \(error.localizedDescription). If you clicked Deny, or the sandbox blocked access, use “Import Passwords CSV…” instead.")
            return
        }

        let profiles = profileDirectories(in: folder, preferred: state.spaces.compactMap { $0.arcProfile })

        if passwords {
            status = "Importing passwords into the Keychain…"
            var saved = 0
            var skipped = 0
            for profile in profiles {
                let file = profile.url.appendingPathComponent("Login Data")
                guard FileManager.default.fileExists(atPath: file.path) else { continue }
                let outcome = await Task.detached(priority: .userInitiated) {
                    Self.importPasswords(from: file, decryptor: decryptor)
                }.value
                saved += outcome.saved
                skipped += outcome.skipped
                if let error = outcome.error { report.errors.append("Passwords (\(profile.name)): \(error)") }
            }
            report.imported.append("Passwords: \(saved) saved to your Keychain")
            if skipped > 0 { report.skipped.append("Passwords that couldn’t be decrypted or had no website: \(skipped)") }
        }

        if cookies {
            status = "Importing cookies into each space’s website data…"
            var imported = 0
            var skipped = 0
            for profile in profiles {
                let candidates = [
                    profile.url.appendingPathComponent("Cookies"),
                    profile.url.appendingPathComponent("Network/Cookies")
                ]
                guard let file = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else { continue }
                let stores = state.dataStores(forArcProfile: profile.name)
                guard !stores.isEmpty else {
                    report.skipped.append("Cookies from Arc profile “\(profile.name)”: no matching space was imported")
                    continue
                }
                let outcome = await Task.detached(priority: .userInitiated) {
                    Self.readCookies(from: file, decryptor: decryptor)
                }.value
                if let error = outcome.error { report.errors.append("Cookies (\(profile.name)): \(error)") }
                skipped += outcome.skipped
                for store in stores {
                    for cookie in outcome.cookies {
                        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                            store.httpCookieStore.setCookie(cookie) { continuation.resume() }
                        }
                    }
                }
                imported += outcome.cookies.count
            }
            report.imported.append("Cookies: \(imported) imported (open tabs may need a reload)")
            if skipped > 0 { report.skipped.append("Cookies that were expired or couldn’t be decrypted: \(skipped)") }
        }
    }

    nonisolated private static func importPasswords(from file: URL, decryptor: ChromiumDecryptor) -> (saved: Int, skipped: Int, error: String?) {
        do {
            let copy = try ChromiumFiles.copyDatabase(file)
            defer { try? FileManager.default.removeItem(at: copy.directory) }
            let database = try SQLiteDatabase(path: copy.file.path)
            var saved = 0
            var skipped = 0
            var firstError: String?
            try database.query("SELECT origin_url, username_value, password_value FROM logins") { row in
                guard let origin = row.string(0), let url = URL(string: origin), let host = url.host(),
                      let blob = row.data(2), let password = decryptor.decrypt(blob), !password.isEmpty else {
                    skipped += 1
                    return
                }
                do {
                    try KeychainStore.savePassword(server: host, account: row.string(1) ?? "", password: password,
                                                   secure: url.scheme != "http")
                    saved += 1
                } catch {
                    skipped += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
            }
            return (saved, skipped, firstError)
        } catch {
            return (0, 0, error.localizedDescription)
        }
    }

    nonisolated private static func readCookies(from file: URL, decryptor: ChromiumDecryptor) -> (cookies: [HTTPCookie], skipped: Int, error: String?) {
        do {
            let copy = try ChromiumFiles.copyDatabase(file)
            defer { try? FileManager.default.removeItem(at: copy.directory) }
            let database = try SQLiteDatabase(path: copy.file.path)

            // Cookie DB schema 24+ prefixes the plaintext with SHA256(host) (32 bytes).
            var schemaVersion = 0
            try? database.query("SELECT value FROM meta WHERE key = 'version'") { row in
                schemaVersion = Int(row.string(0) ?? "") ?? 0
            }

            var cookies: [HTTPCookie] = []
            var skipped = 0
            let now = Date()
            let handler: (SQLiteRow, Bool) -> Void = { row, hasSameSite in
                guard let host = row.string(0), let name = row.string(1) else {
                    skipped += 1
                    return
                }
                var value = row.string(2) ?? ""
                if value.isEmpty, let blob = row.data(3) {
                    guard var plain = decryptor.decrypt(blob) else {
                        skipped += 1
                        return
                    }
                    if schemaVersion >= 24 && plain.count >= 32 { plain = plain.dropFirst(32) }
                    guard let string = String(data: Data(plain), encoding: .utf8) else {
                        skipped += 1
                        return
                    }
                    value = string
                }
                var properties: [HTTPCookiePropertyKey: Any] = [
                    .domain: host,
                    .path: (row.string(4).flatMap { $0.isEmpty ? nil : $0 }) ?? "/",
                    .name: name,
                    .value: value
                ]
                if let expires = ChromiumFiles.date(fromChromeTime: row.int64(5)) {
                    guard expires > now else {
                        skipped += 1
                        return
                    }
                    properties[.expires] = expires
                } else {
                    properties[.discard] = "TRUE"
                }
                if row.int64(6) != 0 { properties[.secure] = "TRUE" }
                if row.int64(7) != 0 { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
                if hasSameSite {
                    switch row.int64(8) {
                    case 1: properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteLax.rawValue
                    case 2: properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict.rawValue
                    default: break
                    }
                }
                if let cookie = HTTPCookie(properties: properties) {
                    cookies.append(cookie)
                } else {
                    skipped += 1
                }
            }

            do {
                try database.query("SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies") { row in
                    handler(row, true)
                }
            } catch {
                cookies.removeAll()
                skipped = 0
                try database.query("SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly FROM cookies") { row in
                    handler(row, false)
                }
            }
            return (cookies, skipped, nil)
        } catch {
            return ([], 0, error.localizedDescription)
        }
    }

    // MARK: Passwords CSV (safer alternative)

    func importPasswordsCSV() async {
        let panel = NSOpenPanel()
        panel.title = "Choose a passwords CSV exported from Arc"
        panel.message = "In Arc: Settings › Passwords › ⋯ › Export passwords. Delete the CSV after importing — it contains your passwords in plain text."
        panel.allowedContentTypes = [.commaSeparatedText, .plainText]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }

        isWorking = true
        report = ImportReport()
        status = "Importing passwords from CSV…"
        let accessing = url.startAccessingSecurityScopedResource()
        defer {
            if accessing { url.stopAccessingSecurityScopedResource() }
            isWorking = false
            status = "Import finished."
        }

        let outcome = await Task.detached(priority: .userInitiated) { () -> (saved: Int, skipped: Int, error: String?) in
            guard let text = try? String(contentsOf: url, encoding: .utf8) else {
                return (0, 0, "Couldn’t read the file as UTF-8 text.")
            }
            return PasswordCSV.importRows(PasswordCSV.parse(text))
        }.value

        if let error = outcome.error { report.errors.append(error) }
        report.imported.append("Passwords from CSV: \(outcome.saved) saved to your Keychain")
        if outcome.skipped > 0 { report.skipped.append("CSV rows without a website or password: \(outcome.skipped)") }
        report.imported.append("You can now delete the CSV file: \(url.lastPathComponent)")
    }
}

enum PasswordCSV {
    /// RFC 4180-style CSV parser (quoted fields, escaped quotes, embedded newlines).
    static func parse(_ text: String) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var inQuotes = false
        let characters = Array(text)
        var index = 0
        while index < characters.count {
            let character = characters[index]
            if inQuotes {
                if character == "\"" {
                    if index + 1 < characters.count && characters[index + 1] == "\"" {
                        field.append("\"")
                        index += 1
                    } else {
                        inQuotes = false
                    }
                } else {
                    field.append(character)
                }
            } else {
                switch character {
                case "\"":
                    inQuotes = true
                case ",":
                    row.append(field)
                    field = ""
                case "\n", "\r\n", "\r":
                    row.append(field)
                    rows.append(row)
                    row = []
                    field = ""
                default:
                    field.append(character)
                }
            }
            index += 1
        }
        if !field.isEmpty || !row.isEmpty {
            row.append(field)
            rows.append(row)
        }
        return rows
    }

    static func importRows(_ rows: [[String]]) -> (saved: Int, skipped: Int, error: String?) {
        guard let header = rows.first?.map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }) else {
            return (0, 0, "The CSV file is empty.")
        }
        func column(_ names: [String]) -> Int? { header.firstIndex { names.contains($0) } }
        guard let urlColumn = column(["url", "origin", "login_uri", "website"]),
              let passwordColumn = column(["password", "login_password"]) else {
            return (0, 0, "The CSV needs “url” and “password” columns (Arc/Chrome export format).")
        }
        let userColumn = column(["username", "login_username", "user", "email"])

        var saved = 0
        var skipped = 0
        var firstError: String?
        for row in rows.dropFirst() {
            guard row.count > max(urlColumn, passwordColumn),
                  let url = URL(string: row[urlColumn]), let host = url.host(),
                  !row[passwordColumn].isEmpty else {
                if !(row.count == 1 && row[0].isEmpty) { skipped += 1 }
                continue
            }
            let account = userColumn.flatMap { $0 < row.count ? row[$0] : nil } ?? ""
            do {
                try KeychainStore.savePassword(server: host, account: account, password: Data(row[passwordColumn].utf8),
                                               secure: url.scheme != "http")
                saved += 1
            } catch {
                skipped += 1
                if firstError == nil { firstError = "Keychain error: \(error.localizedDescription)" }
            }
        }
        return (saved, skipped, firstError)
    }
}

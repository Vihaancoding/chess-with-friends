import Foundation
import Security

enum KeychainError: LocalizedError {
    case status(OSStatus)

    var errorDescription: String? {
        switch self {
        case .status(let status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return message
        }
    }
}

/// Keychain access. Decrypted passwords are only ever written here.
enum KeychainStore {
    static let importedDescription = "ArcX imported password"

    struct Item: Identifiable, Hashable {
        let server: String
        let account: String
        var id: String { server + "\u{1F}" + account }
    }

    /// Reads a generic password item owned by another app (e.g. "Arc Safe Storage").
    /// macOS shows its own prompt asking the user to allow access.
    static func readGenericPassword(service: String) throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError.status(status)
        }
        return data
    }

    static func savePassword(server: String, account: String, password: Data, secure: Bool) throws {
        let protocolValue = secure ? kSecAttrProtocolHTTPS : kSecAttrProtocolHTTP
        let base: [String: Any] = [
            kSecClass as String: kSecClassInternetPassword,
            kSecAttrServer as String: server,
            kSecAttrAccount as String: account,
            kSecAttrProtocol as String: protocolValue
        ]
        var attributes = base
        attributes[kSecValueData as String] = password
        attributes[kSecAttrDescription as String] = importedDescription
        attributes[kSecAttrLabel as String] = server
        attributes[kSecAttrComment as String] = "Imported into ArcX"

        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update: [String: Any] = [
                kSecValueData as String: password,
                kSecAttrDescription as String: importedDescription
            ]
            let updateStatus = SecItemUpdate(base as CFDictionary, update as CFDictionary)
            guard updateStatus == errSecSuccess else { throw KeychainError.status(updateStatus) }
        } else if status != errSecSuccess {
            throw KeychainError.status(status)
        }
    }

    static func listImported() -> [Item] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassInternetPassword,
            kSecAttrDescription as String: importedDescription,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let rows = result as? [[String: Any]] else { return [] }
        let items = rows.compactMap { row -> Item? in
            guard let server = row[kSecAttrServer as String] as? String else { return nil }
            return Item(server: server, account: row[kSecAttrAccount as String] as? String ?? "")
        }
        return Array(Set(items)).sorted { ($0.server, $0.account) < ($1.server, $1.account) }
    }

    static func password(server: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassInternetPassword,
            kSecAttrServer as String: server,
            kSecAttrAccount as String: account,
            kSecAttrDescription as String: importedDescription,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func deleteAllImported() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassInternetPassword,
            kSecAttrDescription as String: importedDescription
        ]
        SecItemDelete(query as CFDictionary)
    }
}

import Foundation
import SQLite3

enum SQLiteError: LocalizedError {
    case open(String)
    case prepare(String)
    case step(String)

    var errorDescription: String? {
        switch self {
        case .open(let message): return "Could not open database: \(message)"
        case .prepare(let message): return "Query failed: \(message)"
        case .step(let message): return "Reading rows failed: \(message)"
        }
    }
}

/// Minimal wrapper over the system SQLite3 library.
final class SQLiteDatabase {
    private var handle: OpaquePointer?

    init(path: String) throws {
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX
        if sqlite3_open_v2(path, &handle, flags, nil) != SQLITE_OK {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown error"
            sqlite3_close(handle)
            handle = nil
            throw SQLiteError.open(message)
        }
        sqlite3_busy_timeout(handle, 2000)
    }

    deinit {
        sqlite3_close(handle)
    }

    func query(_ sql: String, row: (SQLiteRow) -> Void) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw SQLiteError.prepare(String(cString: sqlite3_errmsg(handle)))
        }
        defer { sqlite3_finalize(statement) }
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_ROW {
                row(SQLiteRow(statement: statement))
            } else if result == SQLITE_DONE {
                break
            } else {
                throw SQLiteError.step(String(cString: sqlite3_errmsg(handle)))
            }
        }
    }
}

struct SQLiteRow {
    let statement: OpaquePointer

    func string(_ column: Int32) -> String? {
        guard let text = sqlite3_column_text(statement, column) else { return nil }
        return String(cString: text)
    }

    func int64(_ column: Int32) -> Int64 {
        sqlite3_column_int64(statement, column)
    }

    func data(_ column: Int32) -> Data? {
        guard let bytes = sqlite3_column_blob(statement, column) else { return nil }
        let count = Int(sqlite3_column_bytes(statement, column))
        guard count > 0 else { return nil }
        return Data(bytes: bytes, count: count)
    }
}

enum ChromiumFiles {
    /// Copies a (possibly locked, in-use) SQLite database plus its WAL/journal into a
    /// private temporary directory. Caller must delete `directory` when done.
    static func copyDatabase(_ source: URL) throws -> (file: URL, directory: URL) {
        let fm = FileManager.default
        let directory = fm.temporaryDirectory.appendingPathComponent("arcx-import-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(source.lastPathComponent)
        try fm.copyItem(at: source, to: destination)
        for suffix in ["-wal", "-journal"] {
            let side = URL(fileURLWithPath: source.path + suffix)
            if fm.fileExists(atPath: side.path) {
                try? fm.copyItem(at: side, to: URL(fileURLWithPath: destination.path + suffix))
            }
        }
        return (destination, directory)
    }

    /// Chromium timestamps: microseconds since 1601-01-01 UTC.
    static func date(fromChromeTime microseconds: Int64) -> Date? {
        guard microseconds > 0 else { return nil }
        return Date(timeIntervalSince1970: Double(microseconds) / 1_000_000 - 11_644_473_600)
    }
}

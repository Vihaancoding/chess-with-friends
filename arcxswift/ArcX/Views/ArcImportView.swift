import SwiftUI

struct ArcImportView: View {
    @EnvironmentObject private var state: BrowserState
    @StateObject private var importer = ArcImporter()
    @State private var showingSensitiveConfirmation = false

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Import from Arc")
                        .font(.title2.weight(.semibold))
                    Text("ArcX reads Arc’s data only from the folder you choose below. Nothing is uploaded anywhere.")
                        .foregroundStyle(.secondary)
                }
            }

            Section("1 · Arc data folder") {
                HStack {
                    Image(systemName: importer.arcFolder == nil ? "folder.badge.questionmark" : "checkmark.circle.fill")
                        .foregroundStyle(importer.arcFolder == nil ? Color.secondary : Color.green)
                    Text(importer.arcFolder?.path ?? "~/Library/Application Support/Arc")
                        .font(.system(.callout, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button("Choose Arc Folder…") { importer.chooseArcFolder() }
                }
                Text("In the panel, ArcX opens ~/Library/Application Support/Arc. Just click “Use This Folder”.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("2 · Spaces, tabs, bookmarks & history") {
                Toggle("Spaces, pinned tabs, folders, favorites and open tabs (StorableSidebar.json)", isOn: $importer.includeSidebar)
                Toggle("Bookmarks", isOn: $importer.includeBookmarks)
                Toggle("History (database is copied first, so Arc can stay open)", isOn: $importer.includeHistory)
                HStack {
                    Spacer()
                    Button("Import") {
                        Task { await importer.runStandardImport(into: state) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(importer.arcFolder == nil || importer.isWorking
                              || !(importer.includeSidebar || importer.includeBookmarks || importer.includeHistory))
                }
            }

            Section {
                Text("Decrypts Arc’s saved passwords and cookies using the “Arc Safe Storage” key from your Keychain. macOS will ask for permission.")
                    .font(.callout)
                HStack {
                    Button("Import Passwords & Cookies…") { showingSensitiveConfirmation = true }
                        .disabled(importer.arcFolder == nil || importer.isWorking)
                    Spacer()
                    Button("Import Passwords CSV… (safer)") {
                        Task { await importer.importPasswordsCSV() }
                    }
                    .disabled(importer.isWorking)
                }
                Text("Safer alternative: in Arc, export your passwords to a CSV file, import it here, then delete the CSV.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Label("3 · Optional, sensitive: passwords & cookies", systemImage: "exclamationmark.shield")
                    .foregroundStyle(.orange)
            }

            if importer.isWorking || importer.status != nil {
                Section("Status") {
                    HStack {
                        if importer.isWorking { ProgressView().controlSize(.small) }
                        Text(importer.status ?? "")
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !importer.report.isEmpty {
                Section("Summary") {
                    ForEach(importer.report.imported, id: \.self) { line in
                        Label(line, systemImage: "checkmark.circle")
                            .foregroundStyle(.primary)
                    }
                    ForEach(importer.report.skipped, id: \.self) { line in
                        Label(line, systemImage: "arrow.uturn.right.circle")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(importer.report.errors, id: \.self) { line in
                        Label(line, systemImage: "xmark.octagon")
                            .foregroundStyle(.red)
                    }
                }
            }

            Section("Not imported — not possible with WebKit or Arc-only features") {
                ForEach(ArcImporter.notImportable, id: \.self) { line in
                    Text("• " + line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .frame(minWidth: 560, minHeight: 600)
        .sheet(isPresented: $showingSensitiveConfirmation) {
            SensitiveImportConfirmation { passwords, cookies in
                Task { await importer.runSensitiveImport(into: state, passwords: passwords, cookies: cookies) }
            }
        }
    }
}

/// Confirmation screen shown before reading "Arc Safe Storage".
private struct SensitiveImportConfirmation: View {
    @Environment(\.dismiss) private var dismiss
    let onConfirm: (_ passwords: Bool, _ cookies: Bool) -> Void

    @State private var passwords = true
    @State private var cookies = true
    @State private var understood = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Import passwords and cookies from Arc", systemImage: "exclamationmark.shield.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 8) {
                bullet("macOS will ask whether ArcX may read the “Arc Safe Storage” Keychain item. That key can decrypt every password and cookie Arc has saved.")
                bullet("ArcX derives the decryption key in memory only, decrypts each item and writes it straight into your macOS Keychain (passwords) or the space’s WebKit cookie store (cookies).")
                bullet("Decrypted values are never logged, written to other files, or sent over the network. Temporary copies of Arc’s databases contain only encrypted data and are deleted right after.")
                bullet("Imported cookies keep you signed in. Anyone with access to your Mac user account could use them, exactly as with Arc.")
                bullet("Safer alternative: export passwords from Arc as CSV and use “Import Passwords CSV…” instead.")
            }
            .font(.callout)

            Divider()

            Toggle("Passwords → macOS Keychain", isOn: $passwords)
            Toggle("Cookies → each space’s website data (stay signed in)", isOn: $cookies)
            Toggle("I understand the risks", isOn: $understood)
                .fontWeight(.semibold)

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Import") {
                    onConfirm(passwords, cookies)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!understood || (!passwords && !cookies))
            }
        }
        .padding(24)
        .frame(width: 500)
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
    }
}

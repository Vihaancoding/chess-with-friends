import Foundation
import CommonCrypto

/// Decrypts Chromium's macOS "v10" secrets: AES-128-CBC, IV = 16 spaces, PKCS7 padding,
/// key = PBKDF2-HMAC-SHA1(Keychain "Safe Storage" password, salt "saltysalt", 1003 rounds, 16 bytes).
/// The derived key lives only in memory for the duration of an import.
struct ChromiumDecryptor: Sendable {
    private let key: Data

    init?(safeStoragePassword: Data) {
        guard !safeStoragePassword.isEmpty else { return nil }
        let salt = Data("saltysalt".utf8)
        var derived = Data(count: kCCKeySizeAES128)
        let derivedCount = derived.count
        let status: Int32 = derived.withUnsafeMutableBytes { derivedBytes in
            salt.withUnsafeBytes { saltBytes in
                safeStoragePassword.withUnsafeBytes { passwordBytes in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        passwordBytes.baseAddress?.assumingMemoryBound(to: CChar.self),
                        safeStoragePassword.count,
                        saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1),
                        1003,
                        derivedBytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        derivedCount
                    )
                }
            }
        }
        guard status == Int32(kCCSuccess) else { return nil }
        key = derived
    }

    /// Returns nil for anything that isn't a well-formed v10 blob.
    func decrypt(_ blob: Data) -> Data? {
        let prefix = Data("v10".utf8)
        guard blob.count > prefix.count, blob.prefix(prefix.count) == prefix else { return nil }
        let cipher = Data(blob.dropFirst(prefix.count))
        guard !cipher.isEmpty, cipher.count % kCCBlockSizeAES128 == 0 else { return nil }

        let iv = Data(repeating: 0x20, count: kCCBlockSizeAES128)
        var output = Data(count: cipher.count + kCCBlockSizeAES128)
        let outputCapacity = output.count
        var moved = 0
        let keyData = key

        let status: Int32 = output.withUnsafeMutableBytes { outputBytes in
            cipher.withUnsafeBytes { cipherBytes in
                iv.withUnsafeBytes { ivBytes in
                    keyData.withUnsafeBytes { keyBytes in
                        CCCrypt(
                            CCOperation(kCCDecrypt),
                            CCAlgorithm(kCCAlgorithmAES),
                            CCOptions(kCCOptionPKCS7Padding),
                            keyBytes.baseAddress, keyData.count,
                            ivBytes.baseAddress,
                            cipherBytes.baseAddress, cipher.count,
                            outputBytes.baseAddress, outputCapacity,
                            &moved
                        )
                    }
                }
            }
        }
        guard status == Int32(kCCSuccess) else { return nil }
        return output.prefix(moved)
    }
}

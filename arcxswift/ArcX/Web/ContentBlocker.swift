import Foundation
import WebKit

/// Compiled WKContentRuleList (native WebKit content blocking — no JavaScript involved).
@MainActor
final class ContentBlocker: ObservableObject {
    nonisolated static let identifier = "arcx-basic-blocklist-v1"
    nonisolated static let enabledKey = "contentBlockerEnabled"

    @Published private(set) var ruleList: WKContentRuleList?
    @Published private(set) var status = "Loading…"

    var isEnabled: Bool {
        UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true
    }

    /// Common ad / tracking hosts, blocked when loaded as third-party resources.
    nonisolated static let blockedDomains: [String] = [
        "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com",
        "googletagmanager.com", "googletagservices.com", "adservice.google.com", "pagead2.googlesyndication.com",
        "adnxs.com", "adsrvr.org", "advertising.com", "amazon-adsystem.com", "criteo.com", "criteo.net",
        "outbrain.com", "taboola.com", "scorecardresearch.com", "quantserve.com", "quantcount.com",
        "moatads.com", "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com", "bidswitch.net",
        "smartadserver.com", "yieldmo.com", "adform.net", "media.net", "hotjar.com", "mouseflow.com",
        "crazyegg.com", "fullstory.com", "chartbeat.com", "chartbeat.net", "mixpanel.com", "segment.io",
        "ads-twitter.com", "static.ads-twitter.com", "analytics.twitter.com", "bat.bing.com", "clarity.ms",
        "adroll.com", "zedo.com", "teads.tv", "33across.com", "sharethrough.com", "indexww.com", "lijit.com",
        "sovrn.com", "contextweb.com", "serving-sys.com", "doubleverify.com", "adsafeprotected.com",
        "imrworldwide.com", "krxd.net", "bluekai.com", "demdex.net", "everesttech.net", "rlcdn.com",
        "tapad.com", "agkn.com", "mathtag.com", "turn.com", "exelator.com", "spotxchange.com",
        "yieldlab.net", "adition.com", "smaato.net", "inmobi.com", "mgid.com", "revcontent.com",
        "propellerads.com", "popads.net", "adcolony.com", "unityads.unity3d.com", "app-measurement.com"
    ]

    nonisolated static var rulesJSON: String {
        var rules: [[String: Any]] = blockedDomains.map { domain in
            [
                "trigger": [
                    "url-filter": "^[a-z]+://([^/:]+\\.)?" + NSRegularExpression.escapedPattern(for: domain) + "[:/]",
                    "load-type": ["third-party"]
                ],
                "action": ["type": "block"]
            ]
        }
        rules.append([
            "trigger": ["url-filter": ".*"],
            "action": [
                "type": "css-display-none",
                "selector": "ins.adsbygoogle, .adsbygoogle, [id^='google_ads_iframe'], [id^='div-gpt-ad'], .ad-slot, .advertisement"
            ]
        ])
        guard let data = try? JSONSerialization.data(withJSONObject: rules),
              let json = String(data: data, encoding: .utf8) else { return "[]" }
        return json
    }

    func load() async {
        let defaultStore: WKContentRuleListStore? = WKContentRuleListStore.default()
        guard let store = defaultStore else {
            status = "Content blocking unavailable"
            return
        }
        if let existing = await lookUp(in: store) {
            ruleList = existing
            status = "\(Self.blockedDomains.count) tracker/ad domains blocked"
            return
        }
        let (list, errorMessage) = await compile(in: store)
        if let list {
            ruleList = list
            status = "\(Self.blockedDomains.count) tracker/ad domains blocked"
        } else {
            status = "Rule list failed to compile: \(errorMessage ?? "unknown error")"
        }
    }

    private func lookUp(in store: WKContentRuleListStore) async -> WKContentRuleList? {
        await withCheckedContinuation { continuation in
            store.lookUpContentRuleList(forIdentifier: Self.identifier) { list, _ in
                continuation.resume(returning: list)
            }
        }
    }

    private func compile(in store: WKContentRuleListStore) async -> (WKContentRuleList?, String?) {
        let json = Self.rulesJSON
        return await withCheckedContinuation { continuation in
            store.compileContentRuleList(forIdentifier: Self.identifier, encodedContentRuleList: json) { list, error in
                continuation.resume(returning: (list, error?.localizedDescription))
            }
        }
    }
}

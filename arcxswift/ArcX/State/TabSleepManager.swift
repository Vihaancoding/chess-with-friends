import AppKit

/// Puts background tabs to sleep after N minutes of inactivity.
///
/// Battery rules: one low-frequency, high-tolerance timer that only exists while an ArcX
/// window is actually visible. When the app is hidden or fully occluded the timer is
/// removed; a catch-up sweep runs as soon as a window becomes visible again.
@MainActor
final class TabSleepManager: ObservableObject {
    nonisolated static let minutesKey = "tabSleepMinutes"
    nonisolated static let defaultMinutes = 10

    weak var state: BrowserState?

    @Published private(set) var lastSweep: Date?
    @Published private(set) var isPaused = true
    @Published private(set) var tabsSleptTotal = 0

    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []

    /// nil = never sleep tabs.
    var sleepAfter: TimeInterval? {
        let minutes = UserDefaults.standard.object(forKey: Self.minutesKey) as? Int ?? Self.defaultMinutes
        return minutes > 0 ? TimeInterval(minutes) * 60 : nil
    }

    func start() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            NSWindow.didChangeOcclusionStateNotification,
            NSApplication.didHideNotification,
            NSApplication.didUnhideNotification,
            NSWindow.willCloseNotification
        ]
        for name in names {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.updateActivity() }
            })
        }
        updateActivity()
    }

    /// Call after the sleep setting changes.
    func reschedule() {
        timer?.invalidate()
        timer = nil
        updateActivity()
    }

    private var appIsVisible: Bool {
        guard !NSApp.isHidden else { return false }
        return NSApp.windows.contains { $0.isVisible && $0.occlusionState.contains(.visible) }
    }

    private func updateActivity() {
        if appIsVisible {
            isPaused = false
            if timer == nil {
                schedule()
                sweep()
            }
        } else {
            isPaused = true
            timer?.invalidate()
            timer = nil
        }
    }

    private func schedule() {
        let limit = sleepAfter ?? 600
        let interval = min(60, max(15, limit / 4))
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sweep() }
        }
        timer.tolerance = interval / 2
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func sweep() {
        state?.archiveStaleTodayTabs()
        guard let state, let limit = sleepAfter else { return }
        lastSweep = Date()
        let now = Date()
        let candidates = state.allTabs.filter { tab in
            tab.webView != nil && !state.isVisible(tab) && now.timeIntervalSince(tab.lastActive) >= limit
        }
        guard !candidates.isEmpty else { return }
        Task {
            for tab in candidates {
                if await state.sleepTab(tab) {
                    tabsSleptTotal += 1
                }
            }
        }
    }

    /// Sleeps every background tab now (still respecting media/PiP/download rules).
    func sleepAllBackgroundTabs() async -> Int {
        guard let state else { return 0 }
        var count = 0
        for tab in state.allTabs where tab.webView != nil && !state.isVisible(tab) {
            if await state.sleepTab(tab) { count += 1 }
        }
        tabsSleptTotal += count
        return count
    }
}

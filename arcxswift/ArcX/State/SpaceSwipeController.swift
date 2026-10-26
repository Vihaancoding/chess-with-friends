import AppKit
import SwiftUI

/// Two-finger horizontal trackpad swipe over the sidebar switches spaces, Arc-style.
/// The sidebar follows the fingers live, then settles on the next space (or springs back).
///
/// Implemented with a local NSEvent monitor for scroll-wheel events: it only receives events
/// while ArcX is the active app, costs nothing when idle, and never touches swipes over the
/// web content (those stay WebKit's back/forward gestures).
@MainActor
final class SpaceSwipeController: ObservableObject {
    weak var state: BrowserState?

    /// Live horizontal offset applied to the sidebar contents while swiping.
    @Published private(set) var offset: CGFloat = 0

    /// Sidebar frame in window coordinates (top-left origin), reported by the sidebar view.
    var sidebarFrame: CGRect = .zero

    private var monitor: Any?
    private var tracking = false
    private var decided = false
    private var horizontal = false
    private var accumulatedX: CGFloat = 0
    private var accumulatedY: CGFloat = 0
    private var swallowMomentum = false

    private let commitDistance: CGFloat = 70

    func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            let consumed = MainActor.assumeIsolated { self?.handle(event) ?? false }
            return consumed ? nil : event
        }
    }

    private func handle(_ event: NSEvent) -> Bool {
        guard event.hasPreciseScrollingDeltas else { return false }

        // Momentum events that follow a space swipe must not scroll the tab list.
        if event.momentumPhase != [] {
            if event.momentumPhase.contains(.ended) || event.momentumPhase.contains(.cancelled) {
                let swallow = swallowMomentum
                swallowMomentum = false
                return swallow
            }
            return swallowMomentum
        }

        if event.phase.contains(.began) {
            tracking = isOverSidebar(event)
            decided = false
            horizontal = false
            accumulatedX = 0
            accumulatedY = 0
            swallowMomentum = false
            return false
        }

        guard tracking else { return false }

        if event.phase.contains(.changed) {
            // Physical finger direction, independent of "natural scrolling".
            let dx = event.isDirectionInvertedFromDevice ? event.scrollingDeltaX : -event.scrollingDeltaX
            accumulatedX += dx
            accumulatedY += abs(event.scrollingDeltaY)
            if !decided, abs(accumulatedX) + accumulatedY > 6 {
                decided = true
                horizontal = abs(accumulatedX) > accumulatedY * 1.3
                if !horizontal { tracking = false }
            }
            guard horizontal else { return false }
            offset = rubberBanded(accumulatedX)
            return true
        }

        if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
            defer {
                tracking = false
                decided = false
            }
            guard horizontal else { return false }
            swallowMomentum = true
            var switched = false
            if event.phase.contains(.ended), abs(accumulatedX) > commitDistance, let state {
                // Fingers moving left reveal the space to the right, like pages.
                switched = state.selectAdjacentSpace(offset: accumulatedX < 0 ? 1 : -1)
            }
            withAnimation(switched ? DS.Motion.space : DS.Motion.standard) {
                offset = 0
            }
            if switched { NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now) }
            return true
        }
        return false
    }

    private func isOverSidebar(_ event: NSEvent) -> Bool {
        guard sidebarFrame.width > 0, let window = event.window, let content = window.contentView else { return false }
        let location = event.locationInWindow
        let point = CGPoint(x: location.x, y: content.bounds.height - location.y)
        return sidebarFrame.contains(point)
    }

    private func rubberBanded(_ x: CGFloat) -> CGFloat {
        guard let state, let index = state.spaces.firstIndex(where: { $0.id == state.currentSpace?.id }) else { return x * 0.3 }
        let hasNext = index < state.spaces.count - 1
        let hasPrevious = index > 0
        let canMove = x < 0 ? hasNext : hasPrevious
        let limited = canMove ? x : x * 0.25
        return max(-120, min(120, limited * 0.6))
    }
}

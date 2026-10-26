# ArcX — an Arc-style browser for macOS (Swift · SwiftUI · WebKit)

A native macOS browser with Arc's layout (vertical sidebar, Spaces, pinned tabs, command bar,
split view). It uses stock `WKWebView` only, so it keeps WebKit's battery and memory behavior.

* macOS 15+, Apple Silicon, Xcode 16+
* No third-party packages, no paid Apple Developer account. It is signed with **Sign to Run Locally**.
* App Sandbox: network client, user-selected files (read/write), Downloads folder.

## Run it

### Option A: XcodeGen (recommended)

```bash
brew install xcodegen          # free
cd arcxswift
xcodegen generate              # creates ArcX.xcodeproj from project.yml
open ArcX.xcodeproj
```

In Xcode, pick the **ArcX** scheme and **My Mac**, then press **⌘R**.

Signing is preset to *Sign to Run Locally* (`CODE_SIGN_IDENTITY = "-"`). If Xcode asks, open
**Target ArcX › Signing & Capabilities** and either leave *Sign to Run Locally* selected or choose
your free *Personal Team* (Xcode › Settings › Accounts › add your Apple ID).

### Option B: plain Xcode (no XcodeGen)

1. Xcode › File › New › Project › **macOS › App**. Product Name `ArcX`, Interface **SwiftUI**,
   Language **Swift**, and no tests or Core Data.
2. Delete the generated `ContentView.swift` and `ArcXApp.swift`.
3. Drag the folders inside `arcxswift/ArcX/` (`App`, `Models`, `State`, `Web`, `Views`, `Import`,
   `Support`) into the project navigator. Choose *Copy items if needed* and *Create groups*, with the ArcX target checked.
4. Target › **General**: Minimum Deployments **macOS 15.0**.
5. Target › **Build Settings**: set *Swift Language Version* to **Swift 5**.
6. Target › **Signing & Capabilities** › App Sandbox: check **Outgoing Connections (Client)**,
   **User Selected File: Read/Write** and **Downloads Folder: Read/Write**. Set Signing Certificate
   to **Sign to Run Locally**, or use your Personal Team.
7. Target › **Build Phases › Link Binary With Libraries**: add `libsqlite3.tbd`.
8. Press **⌘R**.

## Design: Apple × Arc

* **Design tokens.** `Support/DesignSystem.swift` holds the 4-pt spacing scale, the radius hierarchy
  (control 7, item 9, panel 12, floating 18), system-font type styles, the layered light/dark palette
  (no pure black) and short spring/ease-out motion curves.
* **Sidebar.** A translucent material carries a faint tint in the current space's color. It holds a
  workspace selector, Pinned and Today sections, foldable folders, and favorites. While you read, it
  softens (Settings › General › Quiet sidebar).
* **Spaces.** Swipe with two fingers over the sidebar to switch spaces, or use ⌃1…9, ⌥⌘← / ⌥⌘→,
  ⌘⇧P, or the space bar. The sidebar follows your fingers. The active-space indicator slides between icons.
* **Drag and drop.** Reorder tabs. Drop a tab into Pinned to pin it, or into Today to unpin it.
  Drop it on a space icon to move it to that space. Insertion points and targets are highlighted.
* **Today tabs** are archived after 12 hours of inactivity by default. Change this in Settings, or
  right-click the Today header. Archived tabs can be restored from History › Archived.
* **Command bar (⌘T / ⌘L / ⌘K).** Results are grouped as Suggestions, Tabs, Spaces, Bookmarks,
  History and Commands, and it is fully keyboard-driven.
* **Start page.** A greeting, one search field, space chips, pinned destinations and recent sites.
* **Responsive.** Wide windows get a 264 pt sidebar and medium ones 236 pt. Below 860 pt the sidebar
  becomes a hover overlay, and a compact floating toolbar appears.
* **Search engine.** Google is the default. DuckDuckGo, Bing and Ecosia can be chosen in Settings.

Not possible in this build: dragging tabs into *another window*, because ArcX is a single-window app.

## Keyboard shortcuts

| Action | Keys |
| --- | --- |
| New tab / command bar | ⌘T |
| Open location / command bar | ⌘L / ⌘K |
| Close tab / reopen closed tab | ⌘W / ⇧⌘T |
| Next / previous tab | ⌘⇧] / ⌘⇧[ (also ⌃⇥ / ⌃⇧⇥) |
| Tab 1–9 | ⌘1…⌘9 |
| Switch space (picker) / space 1–9 / next–previous | ⌘⇧P / ⌃1…⌃9 / ⌥⌘→ ⌥⌘← |
| Toggle sidebar (hover the left edge to peek) | ⌘S |
| Pin / unpin tab, copy link | ⌘D, ⇧⌘C |
| Find on page / next / previous | ⌘F / ⌘G / ⇧⌘G |
| Zoom in / out / actual size | ⌘= / ⌘- / ⌘0 |
| Back / forward / reload / stop | ⌘[ / ⌘] / ⌘R / ⌘. |
| Split view | ⌃⇧= |
| History, bookmarks and archive | ⌘Y |
| Tab memory debug view | ⌥⌘M |

## Architecture (MVVM)

```
ArcX/
  App/        ArcXApp (scenes), BrowserCommands (menus & shortcuts)
  Models/     Space, BrowserTab ("Tab"), Codable records
  State/      BrowserState (view model), TabSleepManager
  Web/        WebViewRepresentable (+ WebViewController: WKNavigationDelegate, WKUIDelegate),
              DownloadManager (WKDownloadDelegate), ContentBlocker (WKContentRuleList)
  Views/      Sidebar, CommandBar, MainContent (split view, find bar), Settings,
              History, MemoryDebug, ArcImport, SpaceSwitcher (+ downloads popover)
  Import/     ArcImporter, ArcSidebarParser, SQLite wrapper, ChromiumDecryptor, KeychainStore
  Support/    Persistence, URL parsing, favicons, colors, visual effect, memory stats
```

The tab model is `BrowserTab` and not `Tab`, because SwiftUI on macOS 15 already has a `Tab` type.

Data is stored in `~/Library/Containers/local.arcx.browser/Data/Library/Application Support/ArcX/`
(`session.json`, `history.json`, `bookmarks.json`, `archive.json`). Each Space has its own persistent
`WKWebsiteDataStore(forIdentifier:)`.

## How WebKit's advantages are kept

* **Stock WKWebView only.** No private API and no Chromium flags. The only JavaScript ArcX runs is
  one-off `evaluateJavaScript` calls in an isolated content world. These run on events (read the favicon
  link after load, read/restore scroll position, check Picture in Picture before sleeping).
  There are no injected or polling user scripts.
* **Tab sleeping.** `TabSleepManager` destroys the `WKWebView` of background tabs after N minutes
  (default 10, set in Settings › General). This frees the tab's WebContent process. A sleeping
  tab keeps its URL, title, favicon, scroll position, WebKit `interactionState` (back/forward list)
  and a JPEG-compressed snapshot. The view is recreated when you select the tab. Tabs that are playing
  media, in Picture in Picture, fullscreen, using the camera or microphone, or downloading are never put to sleep.
* **No hidden work.** The sleep timer runs every 15–60 s with 50% tolerance, and only while an
  ArcX window is visible. It is removed when the app is hidden or occluded, and a catch-up check runs
  when a window becomes visible again. The progress bar animates only while a page is loading. The memory
  view refreshes only when you ask.
* **No preview web views.** Command bar suggestions come from in-memory tabs, bookmarks and history.
  Favicons are loaded with `URLSession`.
* **Native media.** AirPlay is allowed, and element fullscreen is on. Picture in Picture uses WebKit's own
  video controls.
* **Content blocking** uses a compiled `WKContentRuleList` (about 80 ad and tracker domains plus a few
  ad-slot CSS hiding rules). You can turn it off in Settings › Privacy.

To check that sleeping works: open the **Tab Memory** window (⌥⌘M), set sleep to 1 minute and
switch away from a few tabs. Then press *Run Sleep Check Now*, or wait. In Activity Monitor, the
"Web Content" processes go away as tabs fall asleep.

## Importing from Arc (File › Import from Arc…)

1. **Choose Arc Folder…** opens an `NSOpenPanel` at `~/Library/Application Support/Arc`.
   ArcX reads only inside the folder you grant (security-scoped access), and assumes no sandbox exemptions.
2. **Import** reads:
   * `StorableSidebar.json`: spaces (name, color, emoji/icon), pinned tabs, folders (shown as
     collapsible groups under Pinned), favorites (the grid at the top of the sidebar) and open tabs.
     Parsing is defensive: unknown fields and item kinds are counted as *skipped* and never fail the import.
     Spaces with the same name are merged and duplicate URLs are skipped.
   * `User Data/<profile>/Bookmarks`: bookmarks, shown in the History & Bookmarks window and the command bar.
   * `User Data/<profile>/History`: copied to a temp folder first, because Arc locks it while running,
     then read with the system SQLite3 library. The newest 10,000 entries are imported.
3. **Optional and sensitive: Passwords & Cookies.** This is behind a confirmation screen that explains the
   risk. It reads the "Arc Safe Storage" Keychain item, and macOS asks you to allow that. It derives the
   key with PBKDF2-SHA1 (salt `saltysalt`, 1003 rounds) and decrypts Chromium's `v10` AES-128-CBC values.
   Passwords go only into your login Keychain. Cookies go only into the matching space's
   `WKHTTPCookieStore`. Nothing decrypted is logged or written anywhere else.
   **Safer alternative:** export passwords from Arc as CSV and use **Import Passwords CSV…**, then delete the CSV.
4. A summary lists what was imported, what was skipped, and any errors.

### What can't be imported

* **Extensions.** Chrome extensions can't run in WKWebView. WebKit also has no public API for a
  third-party browser to host Safari Web Extensions.
* **Boosts.** These are Arc-specific page modifications. Re-creating them would mean injecting user
  scripts, which ArcX deliberately avoids.
* **Easels and Notes.** These are Arc-only formats.
* **Split-view layouts.** The tabs are imported individually.
* Little Arc, Peek, Air Traffic Control and Arc Max features.
* **Password autofill.** Imported passwords are in the Keychain, and Settings › Passwords can copy them.
  WKWebView has no public autofill API for third-party browsers.
* **Keychain access from the sandbox.** If macOS refuses access to "Arc Safe Storage" for a
  sandboxed, locally signed app, the importer reports this clearly. Use the CSV route instead.

## Known limitations

* There is no public API for per-`WKWebView` memory use. The debug view shows the app process footprint,
  which tabs are awake or asleep, and snapshot sizes. Use Activity Monitor for the WebContent processes.
* Picture in Picture is detected before sleeping by a one-off DOM check (`webkitPresentationMode`).
  A tab whose video is *playing* is never slept, whether or not it is in PiP.

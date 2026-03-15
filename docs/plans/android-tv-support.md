# Android TV Support for Solax FVE Monitor

## Context

The app is a vanilla HTML/CSS/JS web app wrapped in Capacitor for Android and iOS. Android TV support is architecturally straightforward since Capacitor's Android wrapper is essentially a WebView inside a standard Android app. The main work is in **manifest changes** and **UI/navigation adaptations**.

## Difficulty Assessment: **Moderate** (1-2 days of work)

The app's fluid flexbox/grid layout already scales well to large screens. The main challenges are:
1. Android TV won't show the app without manifest changes
2. No D-pad/keyboard navigation exists (TV has no touchscreen)
3. Small text/targets for 10-foot viewing distance

## WebView on Android TV

WebView on Android TV is well-supported and a pragmatic choice for this app:

**What works well:**
- Android TV runs standard Android, so `android.webkit.WebView` (which Capacitor uses) is fully available
- HTML/CSS/JS rendering, network requests, and JavaScript APIs all work normally
- The system WebView gets updates via Google Play, same as on phones/tablets

**Known limitations:**
- **Performance varies by hardware** — budget TV sticks have weak CPUs/GPUs, so heavy CSS animations can feel sluggish. This app is lightweight, so it should be fine.
- **D-pad focus in WebView** — the Android WebView has basic spatial navigation support (`WebSettings.setSupportSpatialNavigation()`), which lets the D-pad move between focusable elements. Adding explicit `tabindex` and keyboard handlers is recommended for reliable navigation.
- **No touch events** — click events fire fine via D-pad Enter key.
- **Input fields** — on-screen keyboard works but is clunky with a remote. This app only has a few text fields (connection setup), so it's acceptable.

**Why WebView is a good fit for this app:**
- It's a **read-only monitoring dashboard** — minimal user interaction needed
- The UI is **simple and lightweight** — no heavy animations or complex DOM
- Text inputs are only used in **settings/connection setup** (one-time configuration)
- Auto-refresh handles data updates without user action

## Required Changes

### 1. Android Manifest (`android/app/src/main/AndroidManifest.xml`)
- Add `<uses-feature android:name="android.software.leanback" android:required="false"/>` — marks as TV-compatible
- Add `<uses-feature android:name="android.hardware.touchscreen" android:required="false"/>` — TV has no touchscreen
- Add `<category android:name="android.intent.category.LEANBACK_LAUNCHER"/>` to the main activity intent-filter
- Add a TV banner icon (320x180px) via `android:banner` attribute

### 2. D-pad / Remote Navigation (`web/index.html` — JS section)
- Add `tabindex` attributes to all interactive elements (buttons, dropdown items, connection cards)
- Add arrow-key event listeners to move focus between UI sections
- Add Enter key to activate focused element (most browsers do this, but verify)
- Add Escape/Back key to close modals and dropdowns
- Replace pull-to-refresh with a visible "Refresh" button (already exists in header, just ensure it's focusable)

### 3. Focus Indicators (`web/index.html` — CSS section)
- Add visible `:focus` and `:focus-visible` styles on all interactive elements (outline or highlight ring)
- Ensure focus is visible against the dark background theme
- Add focus trap inside modals (so D-pad doesn't escape the modal)

### 4. TV Layout Tweaks (`web/index.html` — CSS section)
- Add a breakpoint for large screens (e.g., `@media (min-width: 1200px)`) with:
  - Slightly larger font sizes for 10-foot readability
  - Larger button/card touch targets
  - Overscan-safe padding (~5% margins or use `env(safe-area-inset-*)`)
- Consider 3-column layout for the dashboard on very wide screens

### 5. Optional: Leanback Theming
- Not strictly required since the app uses a WebView
- Android TV Leanback library is **not needed** — it's for native Android TV UIs, not WebView apps

## What Already Works Well
- Fluid layout scales to large screens
- Auto-refresh is already built in (no manual refresh needed for monitoring)
- Network permissions are minimal (just INTERNET)
- The data-display nature of the app (monitoring dashboard) is a natural fit for TV

## Verification
1. Use Android TV emulator in Android Studio (API 34, TV profile)
2. Verify app appears in TV launcher
3. Navigate entire UI with arrow keys + Enter + Back
4. Check readability from ~3m distance on emulator
5. Test modal open/close and settings flow with D-pad only
6. Run `npx cap sync android && cd android && ./gradlew assembleDebug`

## Files to Modify
- `android/app/src/main/AndroidManifest.xml` — manifest entries
- `web/index.html` — CSS focus styles, layout breakpoints, JS keyboard navigation
- `android/app/src/main/res/drawable/` — add TV banner image (320x180)

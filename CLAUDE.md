# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A single-file, vanilla ES5 browser script ([QualityUser.js](QualityUser.js)) that fires a Yandex Metrika goal (`reachGoal`) once a visitor passes a "quality user" filter. It is meant to be pasted as a **Custom HTML tag in Google Tag Manager** (note the surrounding `<script>` tags in the file — they are required for that paste flow, not artifacts to be removed). The README, in Russian, also describes the intended use: training Yandex Direct auto-strategies on engaged traffic only, while filtering out RSYa bot traffic.

There is no build, no bundler, no test runner, no lint config, and no package manager. "Develop" means edit `QualityUser.js`; "deploy" means re-paste it into GTM.

## Configuration the user must change before deploying

These constants at the top of [QualityUser.js](QualityUser.js) are placeholders, not defaults:

- `METRIKA_COUNTER_ID` — set to `12345678` in the repo. Must be replaced with the site's real Metrika counter ID.
- `METRIKA_TARGET` — the goal identifier; the README's GTM walkthrough uses `QualityUsers` (note: README says `QualityUsers`, code currently says `QualityUser` — keep them aligned when editing).
- `MIN_TIME_ON_SITE` — milliseconds. README gives recommended ranges per site type (lander 20–30s, shop 30–60s, blog 60–120s).

## Trigger flow (the part that requires reading the whole file)

The goal fires inside `trackInterestedUser()` when **all** of these are true:

1. `isUserActive` — set on the first of `load`/`mousemove`/`keydown`/`scroll`/`touchstart` (each registered with `{ once: true }`); this also stamps `startTime`.
2. **Any one** engagement signal: elapsed time ≥ `MIN_TIME_ON_SITE`, OR `textSelected` (selectionchange with non-empty selection), OR `deviceMotionDetected`, OR `deviceOrientationDetected` (last two are throttled to 1s).
3. `!isBot()` — combines a User-Agent regex list with behavioural checks (see "Bot detection caveats" below).
4. `isWithinDailyLimit()` — daily counter under `maxGoalCountPerDay` (default 3), persisted in `localStorage` under key `interested_user_daily_counter`.

`trackInterestedUser` is invoked from three places: a `setTimeout(..., MIN_TIME_ON_SITE)` scheduled when the user first becomes active, and directly from the text-selection / device-motion / device-orientation handlers.

## Bot detection — what it actually catches

The detector is best-effort heuristic, **not** a security boundary. Specifically:

- A headless browser that overrides `navigator.userAgent` and sets `navigator.webdriver = false` (trivial via CDP `Page.addScriptToEvaluateOnNewDocument`) passes every check here. Don't oversell this script as bot protection — its real value is filtering casual crawlers and unconfigured headless setups, not motivated abuse.
- `BOT_UA_PATTERNS` is mostly symbolic. Honest crawlers (Googlebot, YandexBot, etc.) generally don't execute JS or don't reach Metrika anyway, and serious headless bots arrive with a forged Chrome UA. The real filtering work is done by `navigator.webdriver`, `HeadlessChrome` detection, and the behavioural checks. Don't expand the UA list expecting it to catch motivated abuse.
- `MAX_GOAL_COUNT_PER_DAY = 3` is a per-browser cap that protects against self-inflated counts from your own visits. For Yandex Direct auto-strategy training the campaign typically needs ~10 conversions per week minimum — if traffic is low and the cap is eating useful signal, raising it to 5–10 (or relying purely on `goalReachedThisSession` per page-load) is a reasonable knob. It's a per-deployment tradeoff, not a universal default.
- Variance-based mouse/scroll checks need **20 samples** to make a verdict, so very short bot visits never trip them. Both checks now require *low variance AND low mean* — the original "low variance only" version flagged real users on inertial trackpad scroll.
- DeviceMotion/Orientation handlers exist but contribute almost nothing on iOS (need `requestPermission()` from a user gesture, never performed) and nothing on desktop. On Android Chrome they fire freely.
- Engagement rule is **AND**: `timeOnSite >= MIN_TIME_ON_SITE && (hasScrolled || hasMouseMoved || textSelected || deviceMotionDetected || deviceOrientationDetected)`. Time-on-site is a hard minimum; the second clause just confirms the visitor is alive (not a tab opened-and-forgotten). Don't relax this back to `OR` — it makes the goal fire on a single Android `devicemotion` tick or any text selection within seconds, which defeats the "quality" semantics promised by the README.
- `'load'` is **deliberately excluded** from `activityEvents`. Including it would start the 30s timer for any visitor (including silent bots and background tabs), so the goal would fire without any human input.
- `watchRequestFrequency` deliberately **does not listen to `mousemove`** — a real mouse fires 30–50 events in half a second and would trip the limit instantly. Mousemove is analysed separately via variance.

The current implementation registers all bot-detection listeners **once** at script load and writes verdicts into module-scope flags (`suspiciousMouse` / `suspiciousScroll` / `suspiciousRequests`). `isBot()` only reads those flags — do not move listener registration back inside `isBot()`, that was the original bug (listener leak + always-false on first call).

The daily counter is stored as `{ date: 'YYYY-MM-DD', count: N }` under `interested_user_daily_counter`; rollover happens on date change. The old "raw integer" format is treated as stale and ignored. Don't replace this with a plain number again.

## Style conventions to preserve

- ES5 only (`var`, `function` expressions, no arrow functions, no `let`/`const`). The file is pasted into arbitrary sites via GTM and must run in the broadest possible browser baseline.
- Comments are in Russian — match the existing language when adding new ones.
- Keep the wrapping `<script>...</script>` tags intact (the README's install flow assumes the file can be copy-pasted directly into a GTM Custom HTML tag).

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A single-file, vanilla ES5 browser script ([QualityUser.js](QualityUser.js)) that fires a Yandex Metrika goal (`reachGoal`) once a visitor passes a "quality user" filter. It is meant to be pasted as a **Custom HTML tag in Yandex Tag Manager (Менеджер тегов Яндекса)** (note the surrounding `<script>` tags in the file — they are required for that paste flow, not artifacts to be removed). The README, in Russian, also describes the intended use: training Yandex Direct auto-strategies on engaged traffic only, while filtering out RSYa bot traffic.

There is no build, no bundler, no test runner, no lint config, and no package manager. "Develop" means edit `QualityUser.js`; "deploy" means re-paste it into МТЯ.

## Configuration the user must change before deploying

These constants at the top of [QualityUser.js](QualityUser.js) are placeholders, not defaults:

- `METRIKA_COUNTER_ID` — set to `12345678` in the repo. Must be replaced with the site's real Metrika counter ID.
- `METRIKA_TARGET` — the goal identifier; both README and code use `QualityUser`. Must match the goal identifier configured in Metrika.
- `MIN_TIME_ON_SITE` — minimum **visible** time on site, milliseconds. README gives recommended ranges per site type (lander 20–30s, shop 30–60s, blog 60–120s).
- `MIN_ACTIVE_TIME` — minimum **active** time (excluding idle), milliseconds. Default 15s, roughly half of `MIN_TIME_ON_SITE`. The two are independent gates and both must be satisfied.
- `IDLE_THRESHOLD` — after this many ms with no input the active-time counter pauses. Default 30s.
- `MAX_GOAL_COUNT_PER_DAY` — per-browser daily cap, default 3.

## Trigger flow (the part that requires reading the whole file)

The goal fires inside `trackInterestedUser()` when **all** of these are true:

1. `isUserActive` — set on the first of `mousemove`/`keydown`/`scroll`/`touchstart` (each registered with `{ once: true }`). `'load'` is deliberately not in this list — see Bot detection section.
2. `getVisibleTime() >= MIN_TIME_ON_SITE` — accumulated foreground-tab time. Background tabs don't count.
3. `activeTime >= MIN_ACTIVE_TIME` — accumulated active time. Tick happens once per second only when the tab is visible AND `lastActivityAt` was within `IDLE_THRESHOLD`.
4. At least one live signal: `hasScrolled || hasMouseMoved || textSelected || deviceMotionDetected || deviceOrientationDetected`.
5. `!isBot()`.
6. `isWithinDailyLimit()` — daily counter under `MAX_GOAL_COUNT_PER_DAY`, persisted as `{ date, count }` under `interested_user_daily_counter`.

When fired, the goal sends the following parameters (sent as the 4th arg to `ym(..., 'reachGoal', ..., params)`):
- `visible_time_sec` — accumulated foreground time, seconds.
- `active_time_sec` — accumulated active time, seconds.
- `scroll_depth_pct` — max scroll depth reached, 0–100%.
- `visit_count` — total visits from this browser (incremented once per script load, persisted in `interested_user_visit_count`).
- `text_selected` — 0 or 1.

These are visible in Metrika as goal parameters and can be used for segmentation / look-alike audiences. Don't remove them — they're how downstream consumers tell sessions apart without firing multiple distinct goals.

`trackInterestedUser` is polled from a 5s `setInterval` (started on first user activity) and called directly from the text-selection / device-motion / device-orientation handlers. Goal fires at most once per page load (`goalReachedThisSession`).

## Bot detection — what it actually catches

The detector is best-effort heuristic, **not** a security boundary. Specifically:

- A headless browser that overrides `navigator.userAgent` and sets `navigator.webdriver = false` (trivial via CDP `Page.addScriptToEvaluateOnNewDocument`) passes every check here. Don't oversell this script as bot protection — its real value is filtering casual crawlers and unconfigured headless setups, not motivated abuse.
- `BOT_UA_PATTERNS` is mostly symbolic. Honest crawlers (Googlebot, YandexBot, etc.) generally don't execute JS or don't reach Metrika anyway, and serious headless bots arrive with a forged Chrome UA. The real filtering work is done by `navigator.webdriver`, `HeadlessChrome` detection, and the behavioural checks. Don't expand the UA list expecting it to catch motivated abuse.
- `MAX_GOAL_COUNT_PER_DAY = 3` is a per-browser cap that protects against self-inflated counts from your own visits. For Yandex Direct auto-strategy training the campaign typically needs ~10 conversions per week minimum — if traffic is low and the cap is eating useful signal, raising it to 5–10 (or relying purely on `goalReachedThisSession` per page-load) is a reasonable knob. It's a per-deployment tradeoff, not a universal default.
- Variance-based mouse/scroll checks need **20 samples** to make a verdict, so very short bot visits never trip them. Both checks now require *low variance AND low mean* — the original "low variance only" version flagged real users on inertial trackpad scroll.
- DeviceMotion/Orientation handlers exist but contribute almost nothing on iOS (need `requestPermission()` from a user gesture, never performed) and nothing on desktop. On Android Chrome they fire freely.
- Engagement rule is **triple AND**: `getVisibleTime() >= MIN_TIME_ON_SITE && activeTime >= MIN_ACTIVE_TIME && liveSignal`. All three are mandatory gates — opening a tab in the background and ignoring it doesn't accumulate visible time; sitting on the page without input doesn't accumulate active time; just hovering without scrolling doesn't trigger a live signal. Don't relax any of these — each closes a real abuse path documented in earlier reviews.
- `'load'` is **deliberately excluded** from `activityEvents`. Including it would start the 30s timer for any visitor (including silent bots and background tabs), so the goal would fire without any human input.
- `watchRequestFrequency` deliberately **does not listen to `mousemove`** — a real mouse fires 30–50 events in half a second and would trip the limit instantly. Mousemove is analysed separately via variance.

The current implementation registers all bot-detection listeners **once** at script load and writes verdicts into module-scope flags (`suspiciousMouse` / `suspiciousScroll` / `suspiciousRequests`). `isBot()` only reads those flags — do not move listener registration back inside `isBot()`, that was the original bug (listener leak + always-false on first call).

The daily counter is stored as `{ date: 'YYYY-MM-DD', count: N }` under `interested_user_daily_counter`; rollover happens on date change. The old "raw integer" format is treated as stale and ignored. Don't replace this with a plain number again.

## Style conventions to preserve

- ES5 only (`var`, `function` expressions, no arrow functions, no `let`/`const`). The file is pasted into arbitrary sites via МТЯ and must run in the broadest possible browser baseline.
- Comments are in Russian — match the existing language when adding new ones.
- Keep the wrapping `<script>...</script>` tags intact (the README's install flow assumes the file can be copy-pasted directly into a Custom HTML tag in МТЯ).
- The whole script runs inside an IIFE — never expose state on `window` unless you have a strong reason. Two localStorage keys (`interested_user_daily_counter`, `interested_user_visit_count`) are the only persistent surface.

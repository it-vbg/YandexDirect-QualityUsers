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
- `GOAL_SCORE_THRESHOLD` — minimum score to fire the goal (0–100), default 60. **The main calibration knob.**
- `SAME_SESSION_GAP_MS` — visit-count debounce, default 30 min.

## Trigger flow (the part that requires reading the whole file)

The goal fires inside `trackInterestedUser()` when **all** of these are true:

1. `isUserActive` — set on the first of `mousemove`/`keydown`/`scroll`/`touchstart` (each registered with `{ once: true }`). `'load'` is deliberately not in this list. **`startActiveTimeTicker()` is also started here** — the active-time `setInterval` does not run for users who never interact.
2. **Minimum gate**: `getVisibleTime() >= MIN_TIME_ON_SITE / 2 && activeTime >= MIN_ACTIVE_TIME / 2 && liveSignal`. This protects the score from being inflated purely by `visit_count` / `copied` without real on-page presence.
3. `calculateScore() >= GOAL_SCORE_THRESHOLD` (default 60 / 100). Score is a weighted sum of normalized signals — see scoring breakdown below.
4. `!isBot()`.
5. `isWithinDailyLimit()`.

### Scoring weights (calibrate against actual Metrika data)

| Signal | Weight | Saturation point |
|---|---|---|
| `visibleTime` | up to 25 | 60s |
| `activeTime` | up to 25 | 30s |
| `maxScrollDepth` | up to 20 | 100% |
| `textSelected` | +10 | binary |
| `copied` (copy event) | +15 | binary |
| `visitCount >= 2` | +5 | binary |
| `visitCount >= 5` | +5 | binary |

Cap is ~105 in theory, ≤100 in practice. `GOAL_SCORE_THRESHOLD = 60` is a starting guess — once you have data in Metrika, look at the `score` parameter distribution and adjust. Lowering it = more conversions, looser quality. Raising it = fewer conversions, tighter quality.

### Goal parameters

When the goal fires, two `ym()` calls happen back-to-back:

1. `ym(id, 'reachGoal', target, params)` — params attached to this goal achievement, visible in Metrika's "Конверсии" report:
   - `score`, `visible_time_sec`, `active_time_sec`, `scroll_depth_pct`, `visit_count`, `text_selected`, `copied`.
2. `ym(id, 'userParams', { quality_score, quality_visit_count })` — bound to ClientID, **available for Audience segmentation in Yandex Audiences / Direct look-alike**. This is the channel that makes the data useful for ad targeting; goal-level params alone don't reach the audience builder. Don't remove it.

`trackInterestedUser` is polled from a 5s `setInterval` (started on first user activity) and called directly from copy / text-selection / device-motion / device-orientation handlers. Goal fires at most once per page load (`goalReachedThisSession`).

### Visit count semantics

`bumpVisitCount` only increments when ≥30 minutes (`SAME_SESSION_GAP_MS`) have passed since the last script load — page refreshes don't bump the counter. `LAST_VISIT_AT_KEY` stores the timestamp.

## Bot detection — what it actually catches

The detector is best-effort heuristic, **not** a security boundary. Specifically:

- A headless browser that overrides `navigator.userAgent` and sets `navigator.webdriver = false` (trivial via CDP `Page.addScriptToEvaluateOnNewDocument`) passes every check here. Don't oversell this script as bot protection — its real value is filtering casual crawlers and unconfigured headless setups, not motivated abuse.
- `BOT_UA_PATTERNS` is mostly symbolic. Honest crawlers (Googlebot, YandexBot, etc.) generally don't execute JS or don't reach Metrika anyway, and serious headless bots arrive with a forged Chrome UA. The real filtering work is done by `navigator.webdriver`, `HeadlessChrome` detection, and the behavioural checks. Don't expand the UA list expecting it to catch motivated abuse.
- `MAX_GOAL_COUNT_PER_DAY = 3` is a per-browser cap that protects against self-inflated counts from your own visits. For Yandex Direct auto-strategy training the campaign typically needs ~10 conversions per week minimum — if traffic is low and the cap is eating useful signal, raising it to 5–10 (or relying purely on `goalReachedThisSession` per page-load) is a reasonable knob. It's a per-deployment tradeoff, not a universal default.
- Variance-based mouse/scroll checks need **20 samples** to make a verdict, so very short bot visits never trip them. Both checks now require *low variance AND low mean* — the original "low variance only" version flagged real users on inertial trackpad scroll.
- DeviceMotion/Orientation handlers exist but contribute almost nothing on iOS (need `requestPermission()` from a user gesture, never performed) and nothing on desktop. On Android Chrome they fire freely.
- Engagement rule is **scoring + minimum gate**, not pure AND. The minimum gate (`visibleTime >= MIN_TIME_ON_SITE/2 && activeTime >= MIN_ACTIVE_TIME/2 && liveSignal`) ensures the score can't be inflated purely by metadata signals (`visit_count`, `copied`) without on-page presence. Don't bypass either layer — they close distinct abuse paths.
- `'load'` is **deliberately excluded** from `activityEvents`. Including it would start the 30s timer for any visitor (including silent bots and background tabs), so the goal would fire without any human input.
- `watchRequestFrequency` deliberately **does not listen to `mousemove`** — a real mouse fires 30–50 events in half a second and would trip the limit instantly. Mousemove is analysed separately via variance.

The current implementation registers all bot-detection listeners **once** at script load and writes verdicts into module-scope flags (`suspiciousMouse` / `suspiciousScroll` / `suspiciousRequests`). `isBot()` only reads those flags — do not move listener registration back inside `isBot()`, that was the original bug (listener leak + always-false on first call).

The daily counter is stored as `{ date: 'YYYY-MM-DD', count: N }` under `interested_user_daily_counter`; rollover happens on date change. The old "raw integer" format is treated as stale and ignored. Don't replace this with a plain number again.

## Style conventions to preserve

- ES5 only (`var`, `function` expressions, no arrow functions, no `let`/`const`). The file is pasted into arbitrary sites via МТЯ and must run in the broadest possible browser baseline.
- Comments are in Russian — match the existing language when adding new ones.
- Keep the wrapping `<script>...</script>` tags intact (the README's install flow assumes the file can be copy-pasted directly into a Custom HTML tag in МТЯ).
- The whole script runs inside an IIFE — never expose state on `window` unless you have a strong reason. Three localStorage keys (`interested_user_daily_counter`, `interested_user_visit_count`, `interested_user_last_visit_at`) are the only persistent surface.

## Known limitations (documented, not bugs)

- **Lazy-load / infinite scroll pages**: `maxScrollDepth` is calculated against `document.documentElement.scrollHeight`, which grows as new content loads. On pages where the denominator grows faster than the numerator, depth never reaches 1.0 and the scroll contribution to score is undercounted. If targeting an infinite-feed product, replace the depth calculation with an `IntersectionObserver` watching a known footer element.
- **The 5s tracking `setInterval` is not auto-stopped** if the user never qualifies. It's a no-op call once a second — negligible overhead, and it also lets a slow user qualify later. Don't add a self-stop without a reason.
- **`IDLE_THRESHOLD = 30000` is permissive on purpose**: long-form readers genuinely don't move the mouse for 30 seconds. If `active_time_sec` distribution in Metrika looks too generous, lower it after seeing real data.

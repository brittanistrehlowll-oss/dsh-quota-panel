![dsh-quota-panel](assets/banner.png)

[简体中文](README.md) · [**English**](README.en.md)

[![version](https://img.shields.io/github/package-json/v/brittanistrehlowll-oss/dsh-quota-panel?label=version&color=4176E6)](https://github.com/brittanistrehlowll-oss/dsh-quota-panel/releases)
[![license](https://img.shields.io/badge/license-MIT-3DA639)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![platform](https://img.shields.io/badge/platform-Web%20%2B%20Desktop-1F6FEB)](#install)
[![dependencies](https://img.shields.io/badge/dependencies-0-22C55E)](package.json)
[![providers](https://img.shields.io/badge/providers-DeepSeek%20%C2%B7%20OpenCode%20%C2%B7%20CommandCode-4176E6)](#configuration)
[![stars](https://img.shields.io/github/stars/brittanistrehlowll-oss/dsh-quota-panel?color=F59E0B)](https://github.com/brittanistrehlowll-oss/dsh-quota-panel/stargazers)

**Provider quota and balance status capsule for the dsh web surface (DeepSeek Harness).** One glanceable line in the bottom-left corner tells you how much money and how much quota is left; click it for the full card, click again to fold it back into one line.

A zero-dependency host plugin: for every configured provider it registers one server-side proxy route `/api/quota/<id>` — the API key is resolved through the credentials seam and **never reaches the browser** — then injects this native widget into the page. The same implementation serves `dsh web` and the official Electron Desktop app, with no Whale Breath (or any other plugin) dependency.

## Interface

Collapsed: one independent "status dot + value" pair per account (e.g. `● ¥58 · ● 86% · ● 23%`), no text labels — only the affected account's own dot changes color. Money is rounded for the glance; the exact reading is in the expanded card and the tooltip.

| Light | Dark |
| --- | --- |
| ![Collapsed (light)](docs/images/capsule-light.png) | ![Collapsed (dark)](docs/images/capsule-dark.png) |

Expanded: balances and usage stacked per account, with an individual five-hour / weekly / monthly progress bar and reset time; CommandCode adds period spend and remaining credits. The refresh and lock buttons sit in the top-right corner.

| Light | Dark |
| --- | --- |
| ![Expanded (light)](docs/images/panel-light.png) | ![Expanded (dark)](docs/images/panel-dark.png) |

Default position in a page (bottom-left, avoiding the sidebar entry, never over the content):

| Light | Dark |
| --- | --- |
| ![In page (light)](docs/images/page-light.png) | ![In page (dark)](docs/images/page-dark.png) |

Interactive offline examples: [light](docs/demo.html) / [dark](docs/demo-dark.html) — self-contained pages written by `npm run demo`; open them in a browser. The data is a local mock and never touches a real account. The pictures above are re-captured from that same injected script by `npm run showcase`; `docs/verification/` holds regression artifacts.

## Features

- **Two sizes, one component** — collapsed 128×34px (about 3.76:1); expanded 168px wide (`--dsh-quota-width`) with content-driven height (about 382px for the three demo accounts), rounded ends, no shadow, growing upward from the bottom edge.
- **Independent per account** — one account going critical only repaints its own dot.
- **"The endpoint failed" is not "the quota is dangerous"** — they do not share a color (see the table below).
- **No invented readings** — a missing or non-finite number is an explicit data error and is never folded to `0%`: "I could not read the number" must not render as "plenty left".
- **Follows the product theme** — driven entirely by the Harness design tokens (`--dsw-alias-*`, `--dsw-static-*`, `--dsw-font-*`) with sensible fallbacks, so it carries no palette of its own.
- **Draggable, remembered, lockable** — the position persists per browser, is re-clamped on resize, and stops moving once locked.
- **One registration, two carriers** — the host half registers on the `connection` exact Fetch registry, which the Web server and the Desktop host both dispatch into.
- **Zero dependencies, zero browser-side secrets** — no npm dependency at all; the browser only talks to `/api/quota/<id>` while the credential stays host-side.
- **Keyboard and accessibility** — Enter/Space toggles, Tab reaches the lock, Space toggles it, Escape collapses and restores focus; the DOM is built with `createElement`/`textContent` only.

## When a provider cannot be refreshed

| situation | dot | value | tooltip |
|---|---|---|---|
| healthy | filled green/amber/red | as reported | the reading |
| refresh failed, we have an earlier reading | **hollow ring** | last known value, muted grey | `数据更新于 15:32` + the failure reason |
| never read since load | neutral grey | `—` | the failure reason |

So a momentary network failure no longer repaints a healthy `¥58.36` as a red `—`. The default refresh interval is 5 seconds and pauses while the page is hidden; the expanded state has a manual refresh button that preserves the open state, and re-entrant requests are merged.

## Install

### Web (`dsh web`)

```sh
dsh plugin --profile web add "github:brittanistrehlowll-oss/dsh-quota-panel"
# restart `dsh web` (bundle layers apply at boot)
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` activates it as a profile layer automatically.

### Desktop (Electron `DeepSeek Harness.exe`)

The package path above does **not** work on the Desktop app: `dsh-desktop-host` ships `config/desktop.cordis.patch.yml`, which disables the `web-startup`, `webserver` and `web-runtime` rows outright (the renderer runs on `dsh-app://` over the IPC pipe, with no listening port). A plugin that injects `webServer` therefore waits forever and never loads.

Since v0.8.0 the host half is carrier-neutral, so the Desktop install is a profile-local relative-path row:

```powershell
# 1) link the source into the desktop profile (junction → edit the repo, restart to apply)
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\plugins\quota-panel" `
  -Target "D:\deepseek\dsh-quota-panel"

# 2) add the insert row to $DSH_HOME\profiles\desktop\cordis.patch.yml
#    (name is relative to the profile; inject keeps only credentials)
#    - insert:
#        - id: quota-panel
#          name: './plugins/quota-panel/lib/index.js'
#          inject: [credentials]
#          config: { refreshMs: 60000, providers: [ … ] }
```

Then **quit and reopen the app** — a window reload is not enough: the Desktop host reads the profile layer once at boot (there is no CLI live-patch watcher). `npm run verify:desktop <profileDir>` boots that composition with the real `runDesktopHost`, no Electron required, and asserts both the injection and the live readings from all three routes (most recently on DSH `0.1.5-rc.2`, see `docs/verification/desktop-carrier-20260914.log`).

Why it works: `/api/*` rides the `connection` exact Fetch registry — the Web server mounts the registry under its HTTP `/api` prefix, and the Desktop host dispatches its piped `/api/*` requests into the same registry. The page script enters index.html as a structured `webserver/index-inject` row, an event both carriers emit. One registration serves both; keys stay host-side.

## Configuration

Each provider is one entry under `providers`. Three renderers ship:

| format | endpoint shape | row |
|---|---|---|
| `deepseek-balance` | `{ "balance_infos": [{ "currency", "total_balance" }] }` | balance `¥58.36` |
| `opencode-usage` | `{ "usage": { "rolling"\|"weekly"\|"monthly": { "percent", "resetsAt" } } }` | highest usage `86%` |
| `command-cost` | API base; the host merges identity, credits and usage | period spend `$16.24` |

Override the shipped defaults in your profile's `cordis.patch.yml`:

```yaml
- id: quota-panel
  config:
    refreshMs: 30000
    providers:
      - id: deepseek
        label: DeepSeek
        credential: DEEPSEEK_API_KEY
        endpoint: https://api.deepseek.com/user/balance
        format: deepseek-balance
        balanceTiers: { critical: 10, warn: 20, healthy: 50 }
      - id: opencode-go
        label: OpenCode Go
        credential: OPENCODE_GO_API_KEY
        endpoint: https://opencode.ai/zen/go/v1/usage
        format: opencode-usage
        windowLabels: { rolling: 五, weekly: 周, monthly: 月 }
        warnPercent: 70
        errorPercent: 90
      - id: command
        label: Command Code
        credential: COMMAND_API_KEY
        endpoint: https://api.commandcode.ai
        format: command-cost
        windowLabels: { fiveHour: 五, weekly: 周 }
        warnPercent: 70
        errorPercent: 90
        currency: USD
```

Fields:

| field | meaning | default |
|---|---|---|
| `id` | route id (`/api/quota/<id>`), `^[a-z0-9-]+$` | required |
| `label` | provider name on the card | required |
| `credential` | credential reference (`$DSH_HOME/.credentials.yaml` or env) | required |
| `endpoint` | quota JSON endpoint (API base for `command-cost`), GET with `Authorization: Bearer <key>` | required |
| `format` | row renderer | `deepseek-balance` |
| `balanceTiers` | (deepseek-balance) `{critical, warn, healthy}` levels | `{10, 20, 50}` |
| `lowBalance` | legacy alias for `balanceTiers.warn` | — |
| `windowLabels` | (opencode-usage) `{rolling, weekly, monthly}`; (command-cost) `{fiveHour, weekly}` | UI language |
| `warnPercent` / `errorPercent` | (opencode-usage, command-cost) thresholds | 70 / 90 |
| `currency` | (command-cost) money currency, 3-letter ISO code | `USD` |
| `refreshMs` | auto-refresh interval, `5000 <= refreshMs <= 86400000` | 5000 |

Validation is strict on purpose: a present-but-invalid number (`NaN`, `Infinity`, a string) is an error rather than a silent fallback to the default, `warnPercent < errorPercent` must hold inside `0..100`, `balanceTiers` must be ordered, and `endpoint` must be **https** — the proxy attaches your API key as a `Bearer` token, so plain `http` is accepted for loopback hosts only (`localhost` / `127.0.0.1` / `::1`).

### DeepSeek balance levels

With the default `balanceTiers {critical: 10, warn: 20, healthy: 50}`:

| balance | state | secondary line |
|---|---|---|
| `<= 10` | error (red dot + value) | 建议充值 |
| `10 < x <= 20` | warn (amber) | 余额紧张 |
| `20 < x <= 50` | ok | 余额正常 |
| `> 50` | ok | 余额充足 |

### OpenCode usage states

`high = max(rolling, weekly, monthly)`:

| usage | state |
|---|---|
| `< warnPercent` | ok (green dot, DeepSeek-blue progress) |
| `>= warnPercent` | warn (amber dot + progress) |
| `>= errorPercent` | error (red dot + progress) |

A window whose `percent` is missing or not a finite number makes the row an explicit data error — it is never folded to `0%`.

### Command Code cost states

`high = max(period spend %, five-hour %, weekly %)`:

| reading | state |
|---|---|
| `< warnPercent` | ok (green) |
| `>= warnPercent` | warn (amber) |
| `>= errorPercent` | error (red) |

The monthly ratio comes from `totalMonthlyCredits` in `/alpha/usage/summary` and `credits.monthlyCredits` in `/alpha/billing/credits`, computed as `used / (used + remaining)` when `periodBasis=billing-period`. Purchased and free credits are excluded from the ratio, and a missing field reads as `—`. The five-hour and weekly ratios come from `windowLimits.used/cap`. The period allowance is not reported by the API; it is reconstructed as `spend + remaining credits` — on a GOAT plan that reads as `$16.24 + $53.77 = $70.01`. A reset date the API does not return is never invented.

## Position and dragging

Both states can be dragged when unlocked:

- **Drag** it anywhere — the panel leaves the default bottom-left position and follows the pointer, clamped so the whole capsule always stays on screen.
- The position is **remembered per browser** (`localStorage`, key `dsh.quota.pos`) and restored on the next load; resizing the window re-clamps it into view.
- **Click** toggles the capsule: a press that travels less than 4px is a click, anything further is a drag (the click that ends a drag is swallowed).
- The lock appears only when expanded; it disables dragging, not toggling, and persists under `dsh.quota.locked`.
- **Right-click while unlocked** restores the default position (24px left, 64px bottom).
- Optional `mountCompact` moves the whole shell; manually saved positions take precedence. An unlocked hosted capsule can be dragged out.

## Security

- API keys are resolved server-side via `ctx.credentials` and only used in the server-to-provider request; the browser only talks to `/api/quota/<id>`.
- Every route answers a normalized envelope — `{ ok: true, data }` or `{ ok: false, error: { code, status, message } }` — with `code` one of `credentials` / `upstream` / `timeout` / `network` / `invalid-body`. An upstream HTML error page is turned into `invalid-body` host-side, so the page script never parses a non-JSON body.
- The route is the trust boundary: it never echoes the credential, and verification asserts the key is absent from the response.
- `endpoint` must be https (loopback http excepted), since the proxy attaches the key as a bearer token.
- The injected card builds DOM with `createElement`/`textContent` only; API response values never pass through `innerHTML`. Refresh failures are reported in `title` hover text (and as a hollow status dot), not as card body copy.

## Changelog

- **v0.8.0** — Carrier-neutral host half: routes register on the `connection` exact Fetch registry (the shared `/api` table the Web server and the Desktop host both dispatch into), and the page script ships as a structured `webserver/index-inject` row — no `webServer` dependency left. Hosts without that registry still fall back to `webServer.register` + `tapIndex`. The plugin now works on the official Electron Desktop app (no HTTP server, `dsh-app://` + IPC). Adds `npm run verify:desktop`.
- **v0.7.0** — Compact capsule with full period details: one 128×34px line collapsed, 168px wide vertical details expanded; period progress and reset times restored; the initial position follows the asynchronously loading sidebar and avoids the bottom entry.
- **v0.6.0** — 176px compact two-state capsule with 28/56px heights; independent bottom-left position, dragging and a persistent lock button; the separate card and toolbar were removed. A valid critical reading is no longer overwritten by an older one, an anomalous number is refused instead of becoming 0, and upstream error bodies are no longer echoed. Adds real mouse/keyboard, two-state mutual-exclusion and text-geometry checks. The CSS ships with the package.
- **v0.5.0** — Command Code (`command-cost`) row: billing-period spend, request / token counts, remaining credits and the five-hour + weekly windows. One horizontal size and one 16px radius for both states (no edge jump). Failed refreshes keep the last good reading as `stale` instead of turning red. Normalized `{ ok, data | error }` route envelope; money formatted from the payload currency via `Intl.NumberFormat`; `Esc` collapses; `aria-controls` and a focus ring; strict config validation; shared Chromium resolution in scripts; CI on every push. Fixes an i18n bug where `{h}`/`{n}` placeholders were never substituted (captions rendered as `当前最高占用 {h}%`).
- **v0.4.0** — Free positioning: the capsule is a drag handle (pointer events, touch-friendly), position persisted per browser and restored on load, viewport clamping, card flip/anchor when placed, right-click reset.
- **v0.3.0** — Two sizes: collapsed capsule (independent per-account dot + battery-colored value) expands into the full card.
- **v0.2.0** — Harness-native card: design tokens, balance tiers, progress bar.
- **v0.1.0** — Initial floating panel: server-side quota proxies + page badge.

## Local development

```sh
npm test              # model, configuration, emitted-script and security tests
npm run demo          # regenerate docs/demo.html + docs/demo-dark.html
npm run verify        # headless-browser DOM/geometry/stale assertions
npm run verify:dark   # same in the dark theme
npm run verify:drag   # synthesize real drags; assert persistence/clamping
npm run verify:route  # offline host-route contract (no real credentials)
npm run verify:desktop -- <profileDir>  # real runDesktopHost composition probe (no Electron)
npm run verify:package # pack, then load the plugin FROM the tarball
npm run screenshot    # verify both themes, write docs/verification/*.png
npm run showcase      # regenerate the project-page art in assets/ and docs/images/
npm run pack          # write dist/dsh-quota-panel-<version>.tgz
npm run check         # test + demo + verify
```

`verify:package` is the release gate: it packs, extracts, and imports the plugin from the extracted copy, asserting that `files` ships everything the plugin reads at runtime (notably `lib/plugin-integration-v1.js`, which is read from disk at import time — a working-tree test would never catch it missing).

`verify:route` runs offline and never reads real credentials by default. An explicit `--live` opts in to the live check. Browser verification covers both themes, real lock/unlock and drag input, keyboard navigation and layout; results are in `docs/verification/`.

`showcase` is an authoring tool, not a gate: it captures the pictures from the script actually injected into `docs/demo.html`, so the README cannot drift from the implementation. The hero banner is rendered with the local desktop font stack, so run it on a machine that has one.

The browser scripts find Chrome, Chromium **or Edge** automatically; override with `CHROME_PATH` / `CHROME_BIN`.

## License

MIT

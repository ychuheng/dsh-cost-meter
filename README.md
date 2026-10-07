# dsh-cost-meter

A DSH plugin that shows **your DeepSeek account balance** and **what the current
session has cost**, as one extra pill in the strip below the composer — right of
the shipped token / cache-hit stats.

```
⏱ 22轮5…   🗄 139M tok…   ¥64.25 · 本次 ¥4.39 ↻   ◐ 45%
                          └── this plugin ──┘
```

Hover it for the breakdown; click `↻` to re-read the balance.

## What it shows

- **Balance** — your real account balance, read from `GET /user/balance`. Click
  `↻` to refresh.
- **本次 (this session)** — what this conversation has cost so far, recomputed as
  the session streams. It reads the `tokenUsage` session projection the Host
  already pushes, so **it keeps working with the network down**.
- **Hover detail** — balance split (granted / topped up), the exchange rate with
  its publication time, the four token buckets, whether the current rate is peak
  or off-peak, and where the prices came from.

## Install

Two routes. Both need the source on the machine, and both end with a restart.

Both now work because the package declares a **bundle** — `dsh.bundle.patch`
pointing at its own `cordis.patch.yml`. That declaration is what lets the app's
plugin manager accept the package at all: without it the manager downloads the
package successfully and then refuses it with *"this package declares no bundle"*.

### Route A — the app's own "Add plugin" dialog

1. **Get the source onto the machine first**, since the dialog wants a path:

   ```
   git clone https://github.com/ychuheng/dsh-cost-meter.git
   ```

   or download and extract the ZIP from
   <https://github.com/ychuheng/dsh-cost-meter>. Keep it somewhere permanent.

2. In the dialog, paste the **absolute path to that directory**, for example
   `D:\tools\dsh-cost-meter`. A relative path is refused. The git URL works too.

   The manager runs `pnpm add <path>` through the app's own bundled package
   manager, so no system-wide `pnpm` is needed.

3. **Enable the bundle** if the manager lists it as a new bundle to select. A
   bundle is applied only while it is enabled; installing it is not the same as
   switching it on. This is the one step whose wording differs between DSH
   versions, so if no such control appears, use Route B instead.

4. Restart — see "Restart the app" below.

### Route B — the bundled installer (recommended)

Route B is recommended because it writes both halves — the link into the profile
and the Loader row — so its result does not depend on any bundle-selection UI.

#### 1. Get the source somewhere permanent

```
git clone https://github.com/ychuheng/dsh-cost-meter.git
cd dsh-cost-meter
```

Or extract the ZIP from <https://github.com/ychuheng/dsh-cost-meter> to a
directory you will keep, for example `D:\tools\dsh-cost-meter`.

Do **not** install from inside a temporary folder or a zip preview — the DSH
profile links to this directory, so moving or deleting it breaks the plugin.

#### 2. Run the installer

```
node install.mjs
```

It targets every profile under `$DSH_HOME/profiles`, or one with `--profile`:

```
node install.mjs --profile desktop
node install.mjs --dsh-home "D:\other\.dsh"
node install.mjs --dry-run          # report what would change, write nothing
```

The installer does two things and reports a third:

1. links this package into each profile's `node_modules`, so the Loader can
   resolve `dsh-cost-meter`;
2. appends one `insert` row to that profile's `cordis.patch.yml` — **additively**.
   Your existing entries and comments are preserved verbatim, and running it twice
   changes nothing.

### Restart the app

**Fully quit and reopen** — including the tray icon. A DSH profile is composed at
startup and there is no hot reload for this layer, so the pill will not appear
until a restart.

### Make sure a key is available

The balance needs a DeepSeek API key under the credential reference named in the
patch row (default `DEEPSEEK_API_KEY`). Store it in **Settings → Models**, or
export it in the environment DSH is launched from. The key is resolved per
operation on the Host and **never reaches the browser**.

If no key is present the cost half still works and the balance reads
*unavailable* — that is the designed degradation, not a failure.

## Uninstall

1. Delete the `- insert:` block for `dsh-cost-meter` from each profile's
   `cordis.patch.yml`.
2. Delete the `node_modules/dsh-cost-meter` link in each profile.
3. Restart the app.

## How pricing works

Prices come from the official page,
<https://api-docs.deepseek.com/quick_start/pricing>, which the Host reads live
and caches for six hours. If the page cannot be parsed into a **complete** table,
the plugin keeps its embedded copy and says so rather than guessing — a wrong
price would be invisible, a stale one carries a date. The rate table is one file,
`lib/pricing-core.mjs`, which the Host both imports and serves to the browser, so
a price is written down in exactly one place.

Rates are USD per 1M tokens and are **two-dimensional**: every bucket has a peak
and an off-peak price, with off-peak exactly half of peak. Peak is
**01:00–04:00 and 06:00–10:00 UTC, Monday–Friday**; everything else is off-peak.
Costs accumulate in USD and are converted for display only, because restating
history at a newer rate would make a past session's cost change while its tokens
did not.

### The figure is an estimate, not a bill

The pill shows `official rate × locally logged tokens`. Tokens reconcile **exactly**
with DSH's own `tokenUsage` projection, and the rate table matches the published
page line for line — but a measured cross-check against actual balance movement
left roughly a 14% difference that was never explained. Treat the **balance** as
authoritative.

A second, known limitation: the session projection reports one aggregate per
bucket and carries no per-call timing, so a session straddling a peak boundary is
priced entirely at one side's rate. The hover detail says so.

## Requirements

- The DSH **desktop app**, or a `dsh web` profile. This plugin targets the Web
  client: it contributes a browser half through `dsh.client`.
- Node 22.19 or newer, to run the installer.
- A DeepSeek API key, for the balance half only.

## License

MIT

# garmin2ssi (Scriptable)

Log a Garmin dive `.fit` straight into your [MySSI](https://my.divessi.com) web
logbook, from **[Scriptable](https://scriptable.app)** on iOS. No server, no
Shell, no GitHub. Pure JavaScript, zero dependencies.

```
share a .fit → decode → dive site from the FIT's GPS
                        (else the phone's location, else your fallback id)
             → resolve id via the public SSI locator
             → log in to MySSI → POST the dive → notification
```

## Demo

Importing a dive (share a `.fit` → pick the site → logged):


## Install on iPhone

1. Scriptable → **+** (new script) three times, paste in and name them exactly:
   `fit`, `ssi`, `garmin-to-ssi` (contents = `scriptable/fit.js`,
   `scriptable/ssi.js`, `scriptable/garmin-to-ssi.js`).
   *(Or drop the three `.js` files into the Scriptable iCloud folder.)*
2. In `garmin-to-ssi` → script settings: turn on **Show in Share Sheet**, and
   under **Share Sheet Inputs** select **File URLs**.
   *Note: Scriptable can reset this whenever the script file changes (an iCloud
   sync, a re-paste) — if sharing a `.fit` stops opening the script, re-check
   these two settings.*

   [settings.webm](https://github.com/user-attachments/assets/ecfc3711-5302-4e9e-8fc4-8cf8bd813323)

   
4. Run it once — it prompts for your MySSI **email / password / member id
   (`SSI_USER_ID`)**, a **fallback dive-site id**, and a **dive-# offset**.
   Stored in the iOS keychain on that device only. (`1018800` North Olmsted Rec
   Center · `1965` White Star Quarry.)

   The FIT carries Garmin's internal `dive_number`, which Garmin Connect shows
   **+1**. Set the offset to `1` so the logged dive number matches Connect
   (keychain key `ssi_dive_nr_offset`). Leave it `0` to log the raw FIT value.

   **To change any of these later** (new password, member id, offset, fallback
   site): run with `?setup=1` — `scriptable:///run?scriptName=garmin-to-ssi&setup=1`
   — or set `SETUP = true` at the top of the script. The prompt reopens
   pre-filled; blank email/password/member-id fields keep their current value.

## Use

- **Garmin Connect app** → the dive → ⋯ → **Export Original** (`.fit`) → Share →
  **garmin-to-ssi**. A notification / Quick Look shows the result.
- Or call it from a Shortcut: *Run Script* action, pass the `.fit` as input.
  **Turn "Run Script in App" ON** in that action if you want the dive-site picker
  — a headless run can't show it and falls back to the nearest site.
- Dry run: set `DRY_RUN = true` at the top of `garmin-to-ssi.js`, or invoke via
  `scriptable:///run?scriptName=garmin-to-ssi&dry=1` — decodes + resolves the
  site, doesn't push.

## If it seems stuck / debugging

Every step is logged three ways:

- the **`-- log --` block** at the bottom of the result / shortcut output,
- the **Scriptable console** (run it in-app and watch),
- **`garmin-to-ssi.log`** in the Scriptable folder — written after *every* step,
  so even a hard freeze leaves a trail. Add `scriptable/view-log.js` as a
  script named `view-log` and run it to dump + copy the last run's log.

Network calls time out at 30 s, `Location.current()` at 15 s, the picker at
120 s, and a **150 s watchdog** force-emits whatever it has. So it should never
hang indefinitely — the last log line tells you which step is slow.

## Dive site

1. The FIT's own surface GPS (`session`/`lap` `start_position`/`end_position`) —
   wins when present. Pool / dry-test dives won't have a real one (the watch may
   still stamp a **stale fix from a past trip** — see below).
2. Otherwise the **phone's current location** (`Location.current()`).
3. Those coords → `POST www.divessi.com/api/locationServices.php` (the public
   locator; it self-fetches a `PHPSESSID` + `SSI_APIKEY` from the locator page) →
   the dive sites it returns, nearest first. The list = sites within
   `MAX_SITE_KM` (default 10) if any, **otherwise every site it returned** (so a
   hand-set location still gets a picker instead of silently falling back).
   - **0 sites returned** → your fallback `SSI_DIVE_SITE_ID`.
   - **1 site, and it's within `MAX_SITE_KM`** → used automatically.
   - **otherwise** → a menu pops up (`name · distance`) so you pick the right
     one, plus a "fallback id" row. It asks **every time**; your last pick for
     that spot (~100 m) is listed first, marked ★. Set `REMEMBER_PICKS = true` to
     reuse that pick silently instead of asking. With no UI (background
     automation) it takes the ★ pick if there is one, else the nearest.
4. No id at all → the dive is **not** pushed (MySSI silently drops a site-less
   POST).

**FIT GPS overrides.** The FIT's location is used as-is (including a spot you set
by hand in Garmin Connect). Two opt-in overrides:

- `FORCE_PHONE_LOCATION = true` / `?loc=phone` — always ignore the FIT's GPS and
  use the phone's (handy when re-testing with an old file).
- `STALE_FIT_KM = <km>` (default `0` = off) — if the FIT fix is farther than this
  from the phone, ask which to use. Leave it `0` if you curate dive locations in
  Connect.

## Result report

Every run, the full report is:

- **copied to the clipboard**,
- written to **`garmin-to-ssi.result.txt`** in the Scriptable folder,
- set as the **script's output** (a Shortcut sees it — add a *Show Result* or
  *Quick Look* action after *Run Script* to see it there), and
- posted as a **notification**.

Run **in-app or from the Share Sheet** and a **Quick Look** also opens with the
report. A headless Shortcut / automation run can't pop UI — use the notification,
the clipboard, or a *Show Result* action.

```
OK - dive logged to MySSI

dive #  7
when    2026-06-06 17:11 (local)
runtime 23 min
depth   3.8 m max  ·  2.9 m avg
temp    27 °C
water   fresh
gas     21% O2

site    White Star Quarry  [1965  ·  2.03 km]
coords  fit  ·  2 within 10 km: White Star Quarry 0.3km, ...
match   locator (picked)

result  created (logbook 6 -> 7)
```

First line is the status: `OK`, `FAILED - <why>`, `DRY RUN`, or `ERROR - <what>`.

## Files

| file | what |
|---|---|
| `scriptable/fit.js` | FIT decoder + dive extractor + geo helpers (no Scriptable APIs) |
| `scriptable/ssi.js` | MySSI 82-field form builder (no Scriptable APIs) |
| `scriptable/garmin-to-ssi.js` | the entry point — keychain, `Request`, `Location`, `args` |
| `scriptable/view-log.js` | optional — dumps `garmin-to-ssi.log` from the last run |
| `reference/ssi_logbook_api.md` | reverse-engineered logbook + locator API |
| `test/` | `node --test` against real `.fit` fixtures — run with `npm test` |

## Dev

```
npm test          # needs Node 18+; no npm install (zero deps)
```

`fit.js` and `ssi.js` are plain CommonJS with no platform calls, so Node tests
exercise the real decode/mapping logic. The HTTP client in `garmin-to-ssi.js`
uses Scriptable's `Request` and is tested on-device.

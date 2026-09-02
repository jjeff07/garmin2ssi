# garmin-ssi (Scriptable)

Log a Garmin dive `.fit` straight into your [MySSI](https://my.divessi.com) web
logbook, from **[Scriptable](https://scriptable.app)** on iOS. No server, no
Shell, no GitHub. Pure JavaScript, zero dependencies.

```
share a .fit → decode → dive site from the FIT's GPS
                        (else the phone's location, else your fallback id)
             → resolve id via the public SSI locator
             → log in to MySSI → POST the dive → notification
```

## Install on iPhone

1. Scriptable → **+** (new script) three times, paste in and name them exactly:
   `fit`, `ssi`, `garmin-to-ssi` (contents = `scriptable/fit.js`,
   `scriptable/ssi.js`, `scriptable/garmin-to-ssi.js`).
   *(Or drop the three `.js` files into the Scriptable iCloud folder.)*
2. In `garmin-to-ssi`, turn on **Share Sheet** (script settings) and let it
   accept files.
3. Run it once — it prompts for your MySSI **email / password / member id
   (`SSI_USER_ID`)** and a **fallback dive-site id**. Stored in the iOS keychain
   on that device only. (`1018800` North Olmsted Rec Center · `1965` White Star
   Quarry.)

## Use

- **Garmin Connect app** → the dive → ⋯ → **Export Original** (`.fit`) → Share →
  **garmin-to-ssi**. A notification / Quick Look shows the result.
- Or call it from a Shortcut: *Run Script* action, pass the `.fit` as input.
- Dry run: set `DRY_RUN = true` at the top of `garmin-to-ssi.js`, or invoke via
  `scriptable:///run?scriptName=garmin-to-ssi&dry=1` — decodes + resolves the
  site, doesn't push.

## Dive site

1. The FIT's own surface GPS (`session`/`lap` `start_position`/`end_position`) —
   always wins when present. Pool dives won't have one.
2. Otherwise the **phone's current location** (`Location.current()`).
3. Those coords → `POST www.divessi.com/api/locationServices.php` (the public
   locator; it self-fetches a `PHPSESSID` + `SSI_APIKEY` from the locator page) →
   nearest site within 5 km, real id.
4. Nothing found → your fallback `SSI_DIVE_SITE_ID`. Still nothing → the dive is
   **not** pushed (MySSI silently drops a site-less POST).

## Files

| file | what |
|---|---|
| `scriptable/fit.js` | FIT decoder + dive extractor + geo helpers (no Scriptable APIs) |
| `scriptable/ssi.js` | MySSI 82-field form builder (no Scriptable APIs) |
| `scriptable/garmin-to-ssi.js` | the entry point — keychain, `Request`, `Location`, `args` |
| `reference/ssi_logbook_api.md` | reverse-engineered logbook + locator API |
| `test/` | `node --test` against real `.fit` fixtures — run with `npm test` |

## Dev

```
npm test          # needs Node 18+; no npm install (zero deps)
```

`fit.js` and `ssi.js` are plain CommonJS with no platform calls, so Node tests
exercise the real decode/mapping logic. The HTTP client in `garmin-to-ssi.js`
uses Scriptable's `Request` and is tested on-device.

# Tally

A free calorie and macro tracker that runs on your iPhone as a home screen app. No App Store, no account, no subscription.

- **Barcode scanning** with the phone camera (UPC and EAN, the codes on US grocery packaging)
- **Food database**: Open Food Facts (millions of packaged products, looked up by barcode) plus USDA FoodData Central (basic foods like "banana" or "chicken breast", and US branded foods)
- Daily log by meal, goals for calories, protein, carbs and fat
- Recent foods for one-tap re-adding, and your own saved foods
- Barcodes that aren't in either database: enter the label once and that barcode scans instantly from then on
- Works offline for viewing and editing your log (lookups need signal)
- Your data stays on your phone. Export a backup from Settings.

## Put it online (free, about 5 minutes)

It has to be served over HTTPS for the camera to work. GitHub Pages does that for free.

1. Create a new public repo on GitHub, for example `tally`.
2. Upload everything in this folder to the root of the repo (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.json`, the `icons` folder).
3. In the repo go to **Settings > Pages**, set **Source** to "Deploy from a branch", branch `main`, folder `/ (root)`, and save.
4. After a minute your app is live at `https://<your-username>.github.io/tally/`.

## Install it on your iPhone

1. Open that link in **Safari** (it has to be Safari for Add to Home Screen to make a proper app).
2. Tap the Share button, then **Add to Home Screen**.
3. Open Tally from the home screen icon. It runs full screen like a normal app.
4. The first time you tap **Scan barcode**, allow camera access.

## Get your own USDA key (recommended, free)

Search works out of the box with USDA's shared demo key, but that key is rate limited across everyone using it. Sign up at https://fdc.nal.usda.gov/api-key-signup (just an email), then paste the key into Tally under **Settings > USDA database key**. Barcode scans use Open Food Facts, which needs no key.

## Things to know

- **Back up now and then.** iOS can clear website data for sites you haven't opened in a long time. Apps added to the home screen are much safer than plain Safari tabs, but use **Settings > Export backup** occasionally (it opens the share sheet, so you can save it to Files or iCloud Drive).
- **Camera prompt.** iOS sometimes asks for camera permission again after the app has been closed for a while. That's an iOS rule for home screen web apps, not something the app can turn off.
- **Database accuracy.** Open Food Facts is crowd sourced. If a scanned item looks off, compare against the label; you can always enter it manually.
- **Updating the app.** Upload changed files to the repo. The app picks up new versions the next time it opens with signal. If you change `sw.js`, bump the `VERSION` string at the top.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout: the daily label, meals, sheets for search, logging, manual entry and settings |
| `styles.css` | Look and feel, light and dark mode |
| `app.js` | All the logic: storage, database lookups, barcode scanner, daily totals |
| `sw.js` | Service worker that caches the app so it opens fast and works offline |
| `manifest.json`, `icons/` | Home screen name and icon |

Barcode scanning uses the open source [html5-qrcode](https://github.com/mebjas/html5-qrcode) library, loaded from unpkg.

Food data from Open Food Facts (Open Database License) and USDA FoodData Central (public domain).

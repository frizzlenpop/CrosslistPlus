# Inventory Sync — eBay & Vinted → Crosslist

A Manifest V3 Chrome Extension that fetches sold and canceled inventory from **eBay** and **Vinted**, then automates marking those items in **Crosslist**.

No servers, no headless browsers — the extension piggybacks on your active browser sessions (cookies) to call each platform's internal API.

---

## How It Works

1. **You log into** Vinted, eBay, and Crosslist in Chrome as usual.
2. **Click the extension icon** and hit **Sync Inventory**.
3. The background service worker fetches your recent sold/canceled orders from Vinted and eBay using `fetch()` with your session cookies.
4. The data is normalized into a common format: `{ platform, title, sku, status }`.
5. The items are forwarded to a **content script** running on `app.crosslist.com`, which automates the Crosslist UI to search for each item and mark it as sold/canceled.

---

## Installation (Unpacked)

1. **Clone or download** this folder to your machine.

2. Open Chrome and navigate to:
   ```
   chrome://extensions
   ```

3. Enable **Developer mode** (toggle in the top-right corner).

4. Click **"Load unpacked"** and select the `VintedFixer` folder (the one containing `manifest.json`).

5. The extension icon should appear in your toolbar. Pin it for easy access.

---

## Setup

1. **Log in** to your Vinted, eBay, and Crosslist accounts in Chrome.

2. Click the extension icon to open the popup.

3. Enter your **Vinted User ID**:
   - Go to your Vinted profile page.
   - Your user ID is the number in the URL: `https://www.vinted.co.uk/member/123456789-yourname` → `123456789`.

4. Toggle which platforms you want to sync (Vinted, eBay, or both).

5. **Open Crosslist** (`app.crosslist.com`) in a tab — the content script needs this tab to be open.

6. Click **Sync Inventory**.

---

## Updating Selectors

Crosslist is a Single Page Application (React/Vue). The CSS selectors used by the content script **will break** when Crosslist deploys UI updates.

When this happens:

1. Open Crosslist in Chrome.
2. Right-click the **search bar** → Inspect.
3. Note the CSS selector and update `SELECTORS.searchInput` in `content-scripts/crosslist.js`.
4. Do the same for listing rows, checkboxes, and action buttons.

The `SELECTORS` object at the top of `crosslist.js` has comments explaining each one.

---

## File Structure

```
VintedFixer/
├── manifest.json                  # Extension manifest (MV3)
├── background/
│   └── service-worker.js          # Fetches data from Vinted & eBay APIs
├── content-scripts/
│   └── crosslist.js               # Automates the Crosslist UI
├── popup/
│   ├── popup.html                 # Extension popup UI
│   └── popup.js                   # Popup logic & messaging
└── README.md
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Vinted returns 401/403 | Make sure you're logged into Vinted in Chrome. The extension uses your session cookies. |
| eBay returns no items | Log into eBay Seller Hub (`ebay.com/sh/ord`) first. The extension queries the Seller Hub API. |
| Crosslist items not found | Update the CSS selectors in `content-scripts/crosslist.js`. Crosslist may have changed their UI. |
| Content script not loading | Reload the extension from `chrome://extensions` and refresh the Crosslist tab. |
| "No listing found" for every item | The search text may not match. Try using SKUs in your listings for more reliable matching. |

---

## Notes

- This extension stores your Vinted User ID in `chrome.storage.local` so you don't have to re-enter it each time.
- Background auto-sync via `chrome.alarms` is included but commented out in `service-worker.js`. Uncomment it to enable periodic syncing.
- All fetches use `credentials: "include"` so Chrome attaches your session cookies automatically.

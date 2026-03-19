# Inventory Sync — Feature Breakdown

**Chrome Extension (Manifest V3) that syncs sold and cancelled inventory from Vinted and eBay into Crosslist.**

---

## Architecture

The extension is composed of four main components:

| Component | File | Role |
|---|---|---|
| **Service Worker** | `background/service-worker.js` | Fetches items from Vinted & eBay APIs, manages sync state, coordinates communication between popup and content script |
| **Popup UI** | `popup/popup.html` + `popup/popup.js` | User-facing interface with tabs for Sync, Review, and History |
| **Content Script** | `content-scripts/crosslist.js` | Runs on `app.crosslist.com`, automates the Crosslist UI to mark items as sold and delist them |
| **Manifest** | `manifest.json` | Extension configuration, permissions, and content script registration |

---

## Features

### 1. Multi-Platform Inventory Fetching

#### Vinted — Sold Items
- **Two-pass fetching** for maximum coverage:
  - **Pass 1 — Wardrobe API**: `GET /api/v2/wardrobe/{userId}/items?cond=sold` — fetches all items marked as sold in the user's wardrobe. Requires the user's numeric Vinted ID.
  - **Pass 2 — Orders API**: `GET /api/v2/my_orders?type=sold` — catches sold items that may not appear in the wardrobe endpoint. Uses session cookies (no user ID needed). Automatically deduplicates against Pass 1 by title.
- **Multi-domain fallback**: Tries `vinted.co.uk` → `.com` → `.fr` → `.de` until a successful response is received. Handles users logged into different Vinted regional domains.
- **Full pagination**: Fetches all pages (50 items per page) so no sold items are missed regardless of volume.
- **Cancelled order exclusion**: Orders with "cancel" or "refund" in their status are skipped during the main sync (handled separately in the Review tab).

#### Vinted — Cancelled Orders (Review Tab)
- Fetches from `GET /api/v2/my_orders?type=sold&status=canceled` with full pagination.
- Returns transaction ID, title, price, cancellation reason, date, and thumbnail URL.
- Filters out items already in sync history before showing them to the user.

#### eBay — Sold & Cancelled Orders
- **All-time order coverage**: Uses a custom time range filter (`timerange:CUSTOM&startDate=0&endDate={tomorrow}`) to fetch every order ever made, not just the default 90-day window.
- **Full pagination**: Fetches in batches of 200 orders per page using offset/limit parameters (safety cap at 5,000 orders).
- **DOM scraping via injected script**: Since eBay Seller Hub has no JSON API, the extension:
  1. Finds or opens an eBay Seller Hub tab
  2. Navigates to the orders page
  3. Injects a scraper function via `chrome.scripting.executeScript`
  4. The scraper reads order data directly from the rendered HTML table
- **Data extracted per order**: Order ID, item title, item number, and SKU (Custom Label).
- **Cancellation scraping**: Separately scrapes `/sh/ord/cancel` for cancelled eBay orders.
- **Deduplication**: Removes duplicate items that may appear across overlapping time ranges.
- **Multi-domain support**: Tries `ebay.co.uk` → `ebay.com`.

---

### 2. Crosslist Automation

The content script (`crosslist.js`) automates the Crosslist web app to process each item:

#### Search & Match
- Types the item title into Crosslist's search bar using **React-compatible input simulation** (uses the native `HTMLInputElement.prototype.value` setter to bypass React's controlled input handling).
- Character-by-character typing with realistic delays to trigger React's key handlers.
- Matches the first listing row whose title contains the first 30 characters of the search term. Falls back to the first result if no exact match.

#### Mark as Sold
- Locates the "Sold" checkbox in the correct table column (dynamically finds the column by reading `<thead>` headers, with fallback to column index 8).
- **Safety guard**: Never unchecks a sold checkbox that's already checked. Only clicks unchecked checkboxes.
- **Verification**: After clicking, re-queries the checkbox to confirm it actually toggled on.

#### Delist from Marketplaces
- Clicks the per-row "Delist" button to open the marketplace selection dialog.
- Finds and clicks the "Delist everywhere" button inside the dialog.
- **Non-blocking**: Doesn't wait for the delist operation to complete on Crosslist's backend. Waits 1.5 seconds, dismisses any notification dialogs, and moves on to the next item.

#### Dialog & Notification Dismissal
- Automatically closes PrimeVue dialog buttons (the "Delisting in progress" dialog).
- Closes PrimeVue toast notifications.
- Closes any lingering `<dialog>` elements with Close/OK/Cancel/Dismiss buttons.

#### Full Click Simulation
- Uses the complete pointer + mouse event sequence (`pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`) for maximum compatibility with UI frameworks.

---

### 3. Sync State Persistence

The extension popup closes whenever the user switches tabs (e.g., when Crosslist is activated). All sync state is persisted to `chrome.storage.local` to survive this:

- **Counters**: Found, Synced, Errors — restored on popup reopen.
- **Activity log**: Up to 200 log entries replayed when the popup reopens.
- **Running status**: If sync is active, the Stop button is shown on reopen.
- **Pending items**: The full list of remaining items is stored so sync can be resumed.
- **Debounced saving**: State saves are batched with a 250ms debounce timer to avoid excessive writes. Critical state changes (sync start/stop) use immediate saves.
- **Crash recovery**: If the service worker restarts mid-sync (e.g., extension reload), the `running` flag is automatically reset to `false` on startup via a `stateReady` promise.

---

### 4. Stop & Resume

- **Stop**: The popup sends `stop-sync` to the service worker, which forwards it to the Crosslist content script. The content script sets an `abortSync` flag and stops after the current item finishes processing.
- **Resume**: After stopping, remaining items are preserved in `syncState.pendingItems`. The Resume button shows how many items are left. On resume:
  - Already-synced items are filtered out by checking against `syncHistory`.
  - Counters are reset for the resumed batch.
  - Only the remaining items are sent to Crosslist.

---

### 5. Sync History

- Every successfully processed item is recorded in `syncHistory` in `chrome.storage.local`.
- Each entry stores: platform, item ID, title, status, action taken, and timestamp.
- **Actions tracked**: `sold` (checkbox only), `sold+delisted` (checkbox + delist), `delisted` (delist only).
- **Deduplication**: On subsequent syncs, items already in history are automatically skipped. This means running sync the next day only processes new items.
- **History cap**: Limited to 500 entries (FIFO — oldest dropped first).
- **History tab**: Shows all entries newest-first with platform badge (colour-coded for Vinted/eBay), title, timestamp, and action label.
- **Clear history**: One-click button to wipe all history (useful for re-syncing everything).

---

### 6. Cancelled Order Review (Review Tab)

A dedicated tab for manually reviewing Vinted cancelled orders before syncing:

- **Fetch**: Pulls all cancelled orders from Vinted's API, filtering out already-synced items.
- **Card UI**: Each order shown as a card with thumbnail image, title, price, date, and cancellation reason.
- **Selective sync**: Each card has a checkbox (checked by default). Users can uncheck orders they don't want to sync.
- **Select All / Deselect All**: Toggle checkbox in the footer.
- **Sync count badge**: The "Sync Selected" button shows how many items are selected.
- **Auto-tab switch**: After clicking Sync, automatically switches to the Sync tab to show progress.
- **Treated as sold**: Selected cancelled orders are synced with `status: "sold"` so Crosslist marks them as sold and delists them.

---

### 7. Popup UI

#### Dark Theme
- Dark background (`#0f1117`) with subtle card borders (`#2a2d3a`).
- Blue accent colour (`#2563eb`) for active states and primary buttons.
- Monospace log output with colour-coded log levels (green for success, yellow for warnings, red for errors).

#### Three-Tab Layout
- **Sync**: Platform toggles, Vinted user ID input, sync/stop/resume buttons, summary counters, activity log.
- **Review**: Fetch and review cancelled Vinted orders for selective syncing.
- **History**: Scrollable list of all synced items with platform, title, date, and action.

#### Platform Toggles
- Vinted and eBay can be independently enabled/disabled before syncing.
- Visual toggle with animated dot indicator.

#### Vinted User ID
- Text input persisted to `chrome.storage.local`.
- Restored automatically on popup open.

#### Summary Counters
- Three stats: Found (total items discovered), Synced (successfully processed), Errors (failed items).

---

## Data Flow

```
1. User clicks "Sync Inventory" in popup
2. popup.js → sends "start-sync" message to service worker
3. service-worker.js:
   a. Fetches from Vinted (wardrobe API + orders API)
   b. Fetches from eBay (scrapes Seller Hub DOM)
   c. Deduplicates and filters against syncHistory
   d. Stores pending items in syncState
   e. Sends items to Crosslist content script via "sync-items" message
4. crosslist.js:
   a. For each item: search → match row → mark sold → delist
   b. Reports progress via "sync-log" and "sync-counts" messages
   c. Records each success via "sync-history-entry" message
   d. Sends "sync-done" when finished or stopped
5. service-worker.js intercepts all progress messages and persists to syncState
6. popup.js receives messages and updates the UI in real-time
```

---

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Persist sync history, sync state, and user settings |
| `activeTab` | Access the current tab for content script injection |
| `scripting` | Inject the eBay scraper and Crosslist content script programmatically |
| `alarms` | Reserved for optional periodic background sync (currently commented out) |

### Host Permissions
- `*://*.vinted.com/*`, `.co.uk`, `.fr`, `.de` — Vinted API access
- `*://*.ebay.com/*`, `.co.uk` — eBay Seller Hub scraping
- `*://app.crosslist.com/*` — Crosslist UI automation

---

## Optional: Automatic Background Sync

The service worker includes a commented-out block for periodic automatic syncing using `chrome.alarms`. When enabled, it triggers a full sync every N minutes (default: 30) without user interaction.

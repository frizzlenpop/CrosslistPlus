// background/service-worker.js — Fetches sold / canceled items from Vinted & eBay,
// normalizes the data, and forwards it to the Crosslist content script.

// ─────────────────────────────────────────────────────────────────────────────
// Sync state — persisted to chrome.storage.local so the popup can survive
// being closed and reopened while sync is running.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SYNC_STATE = {
  running: false,
  found: 0,
  synced: 0,
  errors: 0,
  logs: [],
  pendingItems: [],
  erroredItems: [],
};

let syncState = { ...DEFAULT_SYNC_STATE };

// Load persisted state from storage on startup.
// All message handlers that read syncState await this promise first.
const stateReady = chrome.storage.local.get({ syncState: DEFAULT_SYNC_STATE }).then((data) => {
  syncState = data.syncState;
  // If the service worker restarted mid-sync, mark it as stopped.
  if (syncState.running) {
    syncState.running = false;
  }
});

let _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => chrome.storage.local.set({ syncState }), 250);
}
function saveNow() {
  if (_saveTimer) clearTimeout(_saveTimer);
  chrome.storage.local.set({ syncState });
}

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast helpers — also persist to syncState for popup restoration.
// ─────────────────────────────────────────────────────────────────────────────

function emitLog(text, level = "info") {
  chrome.runtime.sendMessage({ type: "sync-log", text, level }).catch(() => {});
  syncState.logs.push({ text, level });
  if (syncState.logs.length > 200) syncState.logs.splice(0, syncState.logs.length - 200);
  scheduleSave();
}

function emitCounts(counts) {
  chrome.runtime.sendMessage({ type: "sync-counts", ...counts }).catch(() => {});
  if (counts.found != null) syncState.found = counts.found;
  if (counts.synced != null) syncState.synced = counts.synced;
  if (counts.errors != null) syncState.errors = counts.errors;
  scheduleSave();
}

// ─────────────────────────────────────────────────────────────────────────────
// VINTED — Fetch recent sold / canceled items
// ─────────────────────────────────────────────────────────────────────────────
//
// Verified endpoint (March 2026):
//   GET /api/v2/wardrobe/{userId}/items?cond=sold&per_page=50&page=1&order=relevance
//
// Response shape:
//   {
//     items: [{
//       id, title, is_closed, item_closing_action ("sold"),
//       price: { amount, currency_code }, ...
//     }],
//     pagination: { current_page, total_pages, total_entries, per_page }
//   }
//
// The `item_closing_action` field distinguishes sold items ("sold") from
// other closed states.  The `status` field on each item is the *condition*
// (e.g. "Very good"), NOT the sale status.
//
// ⚠️  Vinted can change these endpoints at any time. If the fetch starts
//     returning 401/403, check DevTools → Network on the Vinted site while
//     browsing your sold items and update the URL below.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchVintedSales(userId, latestOnly = false) {
  emitLog(latestOnly ? "Fetching latest Vinted sold items..." : "Fetching all Vinted sold items...");

  // We try multiple Vinted domains because the user might be logged into
  // .com, .co.uk, .fr, .de, etc.  The first successful response wins.
  const domains = [
    "www.vinted.co.uk",
    "www.vinted.com",
    "www.vinted.fr",
    "www.vinted.de",
  ];

  // In "latest" mode, only fetch page 1 (50 items) from each API.
  // In "full" mode, paginate through everything.
  const maxPages = latestOnly ? 1 : Infinity;

  let items = [];
  const seenTitles = new Set();
  let workingDomain = null;

  // ── Pass 1: Wardrobe API (requires userId) ──────────────────────────────
  if (userId) {
    for (const domain of domains) {
      try {
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages && page <= maxPages) {
          const url =
            `https://${domain}/api/v2/wardrobe/${userId}/items` +
            `?cond=sold&per_page=50&page=${page}&order=relevance`;

          const res = await fetch(url, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });

          if (!res.ok) {
            emitLog(`Vinted wardrobe (${domain}): HTTP ${res.status} on page ${page}`, "warn");
            break;
          }

          const json = await res.json();
          const rawItems = json.items || [];

          for (const item of rawItems) {
            items.push({
              platform: "vinted",
              id:       String(item.id),
              title:    item.title || "(untitled)",
              sku:      "",
              status:   deriveVintedStatus(item),
            });
            seenTitles.add((item.title || "").toLowerCase().trim());
          }

          totalPages = json.pagination?.total_pages || 1;
          page++;
        }

        if (items.length > 0) {
          emitLog(`Vinted wardrobe (${domain}): found ${items.length} item(s).`, "ok");
          workingDomain = domain;
          break;
        }
      } catch (err) {
        emitLog(`Vinted wardrobe (${domain}): ${err.message}`, "warn");
      }
    }
  }

  // ── Pass 2: Orders API (session-based, no userId needed) ────────────────
  // Catches sold items that may not appear in the wardrobe endpoint.
  const orderDomains = workingDomain ? [workingDomain] : domains;
  for (const domain of orderDomains) {
    try {
      let page = 1;
      let totalPages = 1;
      let orderCount = 0;

      while (page <= totalPages && page <= maxPages) {
        const url =
          `https://${domain}/api/v2/my_orders` +
          `?type=sold&per_page=50&page=${page}`;

        const res = await fetch(url, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });

        if (!res.ok) break;

        const json = await res.json();
        const orders = json.my_orders || [];

        for (const order of orders) {
          const status = (order.status || "").toLowerCase();

          // Allowlist approach — only accept orders with confirmed completion.
          // Empty status is allowed (Vinted often returns no status for finalized transactions).
          const ALLOWED_STATUSES = ["completed", "delivered", "finalised", "finalized"];
          const BLOCKED_STATUSES = ["cancel", "refund", "dispute", "pending", "processing", "shipping"];

          const isAllowed = status === "" || ALLOWED_STATUSES.some((s) => status.includes(s));
          const isBlocked = BLOCKED_STATUSES.some((s) => status.includes(s));

          if (isBlocked) continue;

          if (!isAllowed) {
            // Unknown status — fail safe, skip with warning.
            console.warn(`[InventorySync] Vinted orders: skipping "${order.title}" — unrecognized status: "${status}"`);
            continue;
          }

          // Skip items already found via the wardrobe API (dedup by title).
          const titleKey = (order.title || "").toLowerCase().trim();
          if (seenTitles.has(titleKey)) continue;

          items.push({
            platform: "vinted",
            id:       `order_${order.transaction_id}`,
            title:    order.title || "(untitled)",
            sku:      "",
            status:   "sold",
          });
          seenTitles.add(titleKey);
          orderCount++;
        }

        totalPages = json.pagination?.total_pages || 1;
        page++;
      }

      if (orderCount > 0) {
        emitLog(`Vinted orders (${domain}): found ${orderCount} additional item(s).`, "ok");
      }
      break; // Used a domain successfully.
    } catch (_err) {
      // Try next domain.
    }
  }

  if (items.length === 0) {
    emitLog("Vinted: no sold items found (or not logged in).", "warn");
  } else {
    emitLog(`Vinted total: ${items.length} sold item(s).`, "ok");
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// VINTED — Fetch cancelled orders for manual review
// ─────────────────────────────────────────────────────────────────────────────
//
// Verified endpoint (March 2026):
//   GET /api/v2/my_orders?type=sold&status=canceled&per_page=50&page={n}
//
// Response shape:
//   {
//     my_orders: [{
//       transaction_id, title, price: { amount, currency_code },
//       status: "Cancelled. Refund processed.",
//       date: "2026-02-22T21:08:40+00:00",
//       photo: { url, thumbnails }
//     }],
//     pagination: { current_page, total_pages, total_entries, per_page }
//   }
//
// Does NOT require userId — uses the logged-in session cookie.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchVintedCancelled(latestOnly = true) {
  const domains = [
    "www.vinted.co.uk",
    "www.vinted.com",
    "www.vinted.fr",
    "www.vinted.de",
  ];

  const maxPages = latestOnly ? 1 : Infinity;
  let items = [];

  for (const domain of domains) {
    try {
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages && page <= maxPages) {
        const url =
          `https://${domain}/api/v2/my_orders` +
          `?type=sold&status=canceled&per_page=50&page=${page}`;

        const res = await fetch(url, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });

        if (!res.ok) break;

        const json = await res.json();
        const orders = json.my_orders || [];

        for (const order of orders) {
          items.push({
            transaction_id: String(order.transaction_id),
            title: order.title || "(untitled)",
            price: order.price
              ? `${order.price.currency_code} ${order.price.amount}`
              : "",
            status: order.status || "Cancelled",
            date: order.date || "",
            photoUrl: order.photo?.thumbnails?.[0]?.url || order.photo?.url || "",
          });
        }

        totalPages = json.pagination?.total_pages || 1;
        page++;
      }

      if (items.length > 0) break; // Stop after first successful domain.
    } catch (_err) {
      // Try next domain.
    }
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// EBAY — Fetch cancelled orders for manual review
// ─────────────────────────────────────────────────────────────────────────────
//
// Navigates to /sh/ord/cancel and scrapes the cancellation table via the
// existing scrapeEbayOrdersFromTab helper.  Returns items in the same shape
// as fetchVintedCancelled so the fetch-cancelled handler can merge them.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchEbayCancelled() {
  const domains = ["www.ebay.co.uk", "www.ebay.com"];

  let tabId = null;
  let usedDomain = null;

  // Re-use an existing eBay Seller Hub tab if one is already open.
  for (const domain of domains) {
    const tabs = await chrome.tabs.query({ url: `*://${domain}/sh/ord*` });
    if (tabs.length > 0) {
      tabId = tabs[0].id;
      usedDomain = domain;
      break;
    }
  }

  if (!tabId) {
    usedDomain = domains[0];
    const newTab = await chrome.tabs.create({
      url: `https://${usedDomain}/sh/ord/cancel`,
      active: false,
    });
    tabId = newTab.id;
    await waitForTabLoad(tabId);
  }

  try {
    const items = await scrapeEbayOrdersFromTab(tabId, usedDomain, "/sh/ord/cancel", "canceled");
    // Normalize to the same shape fetchVintedCancelled returns so the
    // fetch-cancelled handler can merge the two arrays transparently.
    return items.map((item) => ({
      transaction_id: item.id,
      title: item.title,
      price: "",
      status: "Cancelled",
      date: new Date().toISOString(),
      photoUrl: "",
      source: "ebay",
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Map Vinted's item_closing_action to our normalized status.
 * The `cond=sold` filter returns items where item_closing_action is "sold".
 * If Vinted ever adds other closing actions (e.g. "cancelled"), this will
 * catch them.
 */
function deriveVintedStatus(item) {
  const action = (item.item_closing_action || "").toLowerCase();
  if (["cancelled", "canceled", "refunded"].includes(action)) return "canceled";
  return "sold";
}

// ─────────────────────────────────────────────────────────────────────────────
// EBAY — Fetch recent sold / canceled orders
// ─────────────────────────────────────────────────────────────────────────────
//
// eBay Seller Hub is fully server-side rendered (no JSON API for orders).
// DOMParser is NOT available in MV3 service workers, so we can't parse the
// HTML here.  Instead we:
//   1. Find or open an eBay Seller Hub tab.
//   2. Navigate it to the "All orders" page.
//   3. Inject a scraper function via chrome.scripting.executeScript that
//      reads order data directly from the live DOM and returns it.
//
// Verified structure (March 2026):
//   URL:   https://www.ebay.co.uk/sh/ord/?filter=status:ALL_ORDERS
//   Table: <table aria-label="Orders"> with <tr> rows.
//   Each row has:
//     - Order ID link:  <a href="...orderid=XX-XXXXX-XXXXX...">
//     - Item link:      <a href="/itm/{itemNumber}">Title</a>
//     - SKU:            <div>Custom label (SKU):</div> <div>VALUE</div>
//
// ⚠️  If eBay changes their HTML, update the scraper in
//     content-scripts/ebay-scraper.js.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchEbaySales(latestOnly = false) {
  emitLog(latestOnly ? "Fetching latest eBay sold items..." : "Fetching all eBay sold items...");

  const domains = ["www.ebay.co.uk", "www.ebay.com"];

  // Try to find an existing eBay Seller Hub tab, or open one.
  let tabId = null;
  let usedDomain = null;

  for (const domain of domains) {
    const tabs = await chrome.tabs.query({ url: `*://${domain}/sh/ord*` });
    if (tabs.length > 0) {
      tabId = tabs[0].id;
      usedDomain = domain;
      break;
    }
  }

  if (!tabId) {
    // No Seller Hub tab open — open a new background tab instead of
    // hijacking the user's existing eBay browsing tab.
    usedDomain = domains[0];
    const newTab = await chrome.tabs.create({
      url: `https://${usedDomain}/sh/ord/?filter=status:PAID_AND_SHIPPED`,
      active: false,
    });
    tabId = newTab.id;
    await waitForTabLoad(tabId);
  }

  let allItems = [];

  // ── Scrape sold orders ──
  // "latest" mode: use LAST90D (fast, single page).
  // "full" mode: use CUSTOM time range from epoch 0 to far-future (all orders, paginated).
  try {
    let soldItems;
    if (latestOnly) {
      soldItems = await scrapeEbayOrdersFromTab(
        tabId,
        usedDomain,
        `/sh/ord/?offset=0&limit=200&filter=status:PAID_AND_SHIPPED,timerange:LAST90D`,
        "sold"
      );
    } else {
      const endDate = Math.floor((Date.now() + 86400000) / 1000); // tomorrow in seconds
      soldItems = await scrapeEbayAllPages(
        tabId,
        usedDomain,
        `status:PAID_AND_SHIPPED,timerange:CUSTOM,startDate:0,endDate:${endDate}`,
        "sold"
      );
    }
    allItems.push(...soldItems);
  } catch (err) {
    emitLog(`eBay sold orders: ${err.message}`, "warn");
  }

  // Scrape cancellations.
  try {
    const cancelledItems = await scrapeEbayOrdersFromTab(
      tabId,
      usedDomain,
      "/sh/ord/cancel",
      "canceled"
    );
    allItems.push(...cancelledItems);
  } catch (err) {
    emitLog(`eBay cancellations: ${err.message}`, "warn");
  }

  // Dedup by item ID (same item can appear in overlapping time ranges).
  const seen = new Set();
  allItems = allItems.filter((item) => {
    const key = `${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (allItems.length > 0) {
    emitLog(`eBay (${usedDomain}): found ${allItems.length} item(s) total.`, "ok");
  } else {
    emitLog("eBay: no sold/canceled items found (or not logged in).", "warn");
  }

  return allItems;
}

/**
 * Scrape all pages of eBay orders for a given filter string.
 * Uses offset/limit pagination (200 items per page).
 */
async function scrapeEbayAllPages(tabId, domain, filter, defaultStatus) {
  let allItems = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const path = `/sh/ord/?offset=${offset}&limit=${limit}&filter=${filter}`;
    const pageItems = await scrapeEbayOrdersFromTab(tabId, domain, path, defaultStatus);

    allItems.push(...pageItems);

    // If we got fewer items than the limit, we've reached the last page.
    if (pageItems.length < limit) break;

    offset += limit;

    // Safety cap — don't loop forever.
    if (offset > 5000) break;
  }

  return allItems;
}

/**
 * Navigate an eBay tab to the given path and inject a scraper to extract
 * order data from the rendered HTML table.
 */
async function scrapeEbayOrdersFromTab(tabId, domain, path, defaultStatus) {
  // Navigate the tab.
  await chrome.tabs.update(tabId, {
    url: `https://${domain}${path}`,
  });
  await waitForTabLoad(tabId);

  // Give Seller Hub a moment to render the order table.
  await new Promise((r) => setTimeout(r, 2000));

  // Inject the scraper function and get results.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapeEbayOrdersDOM,
    args: [defaultStatus],
  });

  // executeScript returns an array of results (one per frame).
  return results?.[0]?.result || [];
}

/**
 * This function runs inside the eBay tab's page context.
 * It reads the order table DOM and returns an array of normalized items.
 *
 * Passed as the `func` argument to chrome.scripting.executeScript.
 *
 * Status validation (second layer of defense after the URL filter):
 *   - For normal order pages: only include rows whose visible status matches
 *     COMPLETED_PATTERNS. Unknown/unreadable status → skip (fail safe).
 *   - For /sh/ord/cancel pages (defaultStatus === "canceled"): all rows are
 *     cancellations, so skip status validation.
 */
function scrapeEbayOrdersDOM(defaultStatus) {
  // Patterns indicating a truly completed/shipped order.
  const COMPLETED_PATTERNS = [
    "paid and shipped", "shipped", "delivered", "completed",
    "paid and delivered", "dispatched",
  ];

  // Patterns indicating a non-completed order — explicit exclusion.
  const EXCLUDED_PATTERNS = [
    "awaiting payment", "awaiting shipment", "pending", "cancel",
    "return", "refund", "dispute", "unpaid", "payment failed",
    "on hold", "not yet shipped",
  ];

  const items = [];
  const rows = document.querySelectorAll("tr");

  for (const row of rows) {
    // Each order row has a link containing orderid= in the href.
    const orderLink = row.querySelector('a[href*="orderid="]');
    if (!orderLink) continue;

    // ── Status validation (skip for cancel pages) ──
    if (defaultStatus !== "canceled") {
      // Read all text content from the row's cells to find a status indicator.
      const cells = row.querySelectorAll("td");
      let rowStatusText = "";
      for (const cell of cells) {
        const cellText = cell.textContent.trim().toLowerCase();
        // Look for cells whose text matches known patterns.
        const isCompleted = COMPLETED_PATTERNS.some((p) => cellText.includes(p));
        const isExcluded = EXCLUDED_PATTERNS.some((p) => cellText.includes(p));
        if (isCompleted || isExcluded) {
          rowStatusText = cellText;
          break;
        }
      }

      const isCompleted = COMPLETED_PATTERNS.some((p) => rowStatusText.includes(p));
      const isExcluded = EXCLUDED_PATTERNS.some((p) => rowStatusText.includes(p));

      if (isExcluded) {
        // Explicitly non-completed — skip.
        continue;
      }

      if (!isCompleted) {
        // Unknown or unreadable status — fail safe, skip.
        const itemLink = row.querySelector('a[href*="/itm/"]');
        const title = itemLink ? itemLink.textContent.trim() : "(unknown)";
        console.warn(`[InventorySync] eBay: skipping "${title}" — unrecognized status: "${rowStatusText || "(empty)"}"`);
        continue;
      }
    }

    // Extract order ID from href.
    const orderIdMatch = orderLink.href.match(/orderid=([^&]+)/);
    const orderId = orderIdMatch ? orderIdMatch[1] : "";

    // Item title + number from the /itm/ link.
    const itemLink = row.querySelector('a[href*="/itm/"]');
    const title = itemLink ? itemLink.textContent.trim() : "(untitled)";
    const itemNum = itemLink
      ? (itemLink.href.match(/\/itm\/(\d+)/) || [])[1] || ""
      : "";

    // SKU: the element right after "Custom label (SKU):" text.
    let sku = itemNum; // Fall back to item number.
    const divs = row.querySelectorAll("div");
    for (const div of divs) {
      if (div.textContent.trim() === "Custom label (SKU):") {
        const next = div.nextElementSibling;
        if (next) {
          sku = next.textContent.trim();
          break;
        }
      }
    }

    items.push({
      platform: "ebay",
      id: itemNum || orderId,
      title,
      sku,
      status: defaultStatus,
    });
  }

  return items;
}

/**
 * Wait for a tab to finish loading.
 * Checks current tab status first to avoid hanging if already loaded.
 * @param {number} tabId
 * @param {number} [timeout=30000]
 * @returns {Promise<void>}
 */
function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    // Check if the tab is already loaded.
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === "complete") {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(`Tab ${tabId} did not finish loading within ${timeout}ms`));
      }, timeout);

      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// De-duplicate items by (platform + id) so we never push the same listing
// twice in one sync run.
// ─────────────────────────────────────────────────────────────────────────────

function dedup(items) {
  const seen = new Set();
  return items.filter((i) => {
    const key = `${i.platform}:${i.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Forward the normalized item list to the Crosslist content script.
// If no Crosslist tab is open, we inject the content script into a new one.
// ─────────────────────────────────────────────────────────────────────────────

async function sendToCrosslist(items, dryRun = false) {
  emitLog(`Sending ${items.length} item(s) to Crosslist${dryRun ? " (DRY RUN)" : ""}...`);

  if (dryRun) {
    // In dry-run mode, just log what would happen without opening Crosslist.
    for (const item of items) {
      emitLog(`  [DRY RUN] Would process: [${item.platform}] "${item.title}" → ${item.status}`);
    }
    emitCounts({ found: items.length, synced: items.length, errors: 0 });
    emitLog(`Dry run complete: ${items.length} item(s) would be processed.`, "ok");
    syncState.running = false;
    saveNow();
    chrome.runtime.sendMessage({ type: "sync-done", completed: true }).catch(() => {});
    return;
  }

  // Find an existing Crosslist tab.
  const tabs = await chrome.tabs.query({ url: "*://app.crosslist.com/*" });

  let tabId;

  if (tabs.length > 0) {
    tabId = tabs[0].id;
    await chrome.tabs.update(tabId, { active: true });
  } else {
    // No tab open — create one and wait for it to finish loading.
    const newTab = await chrome.tabs.create({ url: "https://app.crosslist.com", active: true });
    tabId = newTab.id;
    await waitForTabLoad(tabId);
    // Give the SPA a moment to bootstrap after the page "load" fires.
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Send the items to the content script.
  try {
    await chrome.tabs.sendMessage(tabId, { type: "sync-items", items });
  } catch {
    // Content script may not be injected yet (e.g. fresh install).  Inject it
    // programmatically and try again.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-scripts/crosslist.js"],
    });
    await new Promise((r) => setTimeout(r, 500));
    await chrome.tabs.sendMessage(tabId, { type: "sync-items", items });
  }

  emitLog("Data sent to Crosslist tab.", "ok");
}

// ─────────────────────────────────────────────────────────────────────────────
// Persist sync history entries from the Crosslist content script.
// Each entry: { platform, id, title, status, action, timestamp }
// Capped at 500 entries (FIFO — oldest dropped first).
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_CAP = 500;

// History entries older than this are considered stale — the item may have been
// returned and relisted, so we allow it to be synced again.
const HISTORY_STALENESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Build a Set of "platform:id" keys from syncHistory, but only for entries
 * that are recent (< HISTORY_STALENESS_MS old).  Older entries are ignored
 * so returned/relisted items can be re-synced.
 */
function buildRecentHistoryKeys(syncHistory) {
  const cutoff = Date.now() - HISTORY_STALENESS_MS;
  return new Set(
    syncHistory
      .filter((e) => (e.timestamp || 0) > cutoff)
      .map((e) => `${e.platform}:${e.id}`)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Consolidated message listener — handles ALL messages from popup and content
// scripts in one place to avoid listener ordering and return-value conflicts.
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // ── Intercept content-script progress messages ──
  if (msg.type === "sync-log") {
    syncState.logs.push({ text: msg.text, level: msg.level || "info" });
    if (syncState.logs.length > 200) syncState.logs.splice(0, syncState.logs.length - 200);
    scheduleSave();
  }
  if (msg.type === "sync-counts") {
    if (msg.found != null) syncState.found = msg.found;
    if (msg.synced != null) syncState.synced = msg.synced;
    if (msg.errors != null) syncState.errors = msg.errors;
    scheduleSave();
  }
  if (msg.type === "sync-done") {
    syncState.running = false;
    if (msg.completed) {
      syncState.pendingItems = [];
      syncState.erroredItems = [];
      // Feature #18: Completion notification.
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Sync Complete",
        message: `${syncState.synced} item(s) synced, ${syncState.errors} error(s).`,
      }).catch?.(() => {});
    }
    saveNow();
  }

  // ── Sync error entry ──
  if (msg.type === "sync-error-entry") {
    if (msg.item) {
      const key = `${msg.item.platform}:${msg.item.id}`;
      const already = syncState.erroredItems.some((i) => `${i.platform}:${i.id}` === key);
      if (!already) {
        syncState.erroredItems.push(msg.item);
        scheduleSave();
      }
    }
    return;
  }

  // ── Sync history entry ──
  if (msg.type === "sync-history-entry") {
    const entry = msg.entry;
    if (entry) {
      chrome.storage.local.get({ syncHistory: [] }, (data) => {
        const history = data.syncHistory;
        history.push(entry);
        if (history.length > HISTORY_CAP) {
          history.splice(0, history.length - HISTORY_CAP);
        }
        chrome.storage.local.set({ syncHistory: history });
      });
    }
    return;
  }

  // ── Get sync state ──
  if (msg.type === "get-sync-state") {
    stateReady.then(() => sendResponse(syncState));
    return true;
  }

  // ── Stop sync ──
  if (msg.type === "stop-sync") {
    chrome.tabs.query({ url: "*://app.crosslist.com/*" }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "stop-sync" }).catch(() => {});
      }
    });
    return;
  }

  // ── Clear errors ──
  if (msg.type === "clear-errors") {
    syncState.erroredItems = [];
    saveNow();
    return;
  }

  // ── Start sync ──
  if (msg.type === "start-sync") {
    (async () => {
      await stateReady;
      if (syncState.running) {
        emitLog("Sync already in progress — ignoring duplicate request.", "warn");
        sendResponse?.({ ok: false, reason: "busy" });
        return;
      }
      try {
        syncState = { running: true, found: 0, synced: 0, errors: 0, logs: [], pendingItems: [], erroredItems: [] };
        saveNow();

        const { platforms, vintedUserId, mode, dryRun } = msg;
        const latestOnly = mode !== "full";
        let allItems = [];

        const jobs = [];
        if (platforms.vinted) jobs.push(fetchVintedSales(vintedUserId, latestOnly));
        if (platforms.ebay)   jobs.push(fetchEbaySales(latestOnly));

        const results = await Promise.allSettled(jobs);
        for (const r of results) {
          if (r.status === "fulfilled") allItems.push(...r.value);
        }

        allItems = dedup(allItems);
        emitCounts({ found: allItems.length });
        emitLog(`Total unique items: ${allItems.length}`);

        if (allItems.length === 0) {
          emitLog("Nothing to sync.", "warn");
          syncState.running = false;
          saveNow();
          chrome.runtime.sendMessage({ type: "sync-done", completed: true }).catch(() => {});
          return;
        }

        const { syncHistory = [] } = await chrome.storage.local.get({ syncHistory: [] });
        const historyKeys = buildRecentHistoryKeys(syncHistory);
        const newItems = allItems.filter((i) => !historyKeys.has(`${i.platform}:${i.id}`));
        const skipped = allItems.length - newItems.length;

        if (skipped > 0) {
          emitLog(`Skipped ${skipped} item(s) already synced (within last 30 days).`, "info");
        }

        if (newItems.length === 0) {
          emitLog("All items already synced. Nothing to do.", "ok");
          syncState.running = false;
          saveNow();
          chrome.runtime.sendMessage({ type: "sync-done", completed: true }).catch(() => {});
          return;
        }

        syncState.pendingItems = newItems;
        saveNow();
        emitLog(`${newItems.length} item(s) to process.`);
        await sendToCrosslist(newItems, dryRun);
      } catch (err) {
        emitLog(`Fatal error: ${err.message}`, "error");
        syncState.running = false;
        saveNow();
        chrome.runtime.sendMessage({ type: "sync-done", completed: false }).catch(() => {});
      }
    })();
    return true;
  }

  // ── Sync manual items ──
  if (msg.type === "sync-manual-items") {
    (async () => {
      await stateReady;
      try {
        const items = msg.items || [];

        // Feature #31: Log session separator if there are existing logs.
        if (syncState.logs.length > 0) {
          syncState.logs.push({ text: "────────────────────────────────", level: "info" });
        }

        // Reset counters but keep existing logs so previous work is visible.
        syncState.running = true;
        syncState.found = 0;
        syncState.synced = 0;
        syncState.errors = 0;
        syncState.pendingItems = [];
        syncState.erroredItems = [];
        saveNow();

        const { syncHistory = [] } = await chrome.storage.local.get({ syncHistory: [] });
        const historyKeys = buildRecentHistoryKeys(syncHistory);
        const newItems = items.filter((i) => !historyKeys.has(`${i.platform}:${i.id}`));

        const skipped = items.length - newItems.length;
        if (skipped > 0) {
          emitLog(`Skipped ${skipped} item(s) already synced (within last 30 days).`, "info");
        }

        emitCounts({ found: newItems.length });

        if (newItems.length === 0) {
          emitLog("All selected items already synced. Nothing to do.", "ok");
          syncState.running = false;
          saveNow();
          chrome.runtime.sendMessage({ type: "sync-done", completed: true }).catch(() => {});
          return;
        }

        syncState.pendingItems = newItems;
        saveNow();
        emitLog(`${newItems.length} item(s) to process.`);
        await sendToCrosslist(newItems);
      } catch (err) {
        emitLog(`Fatal error: ${err.message}`, "error");
        syncState.running = false;
        saveNow();
        chrome.runtime.sendMessage({ type: "sync-done", completed: false }).catch(() => {});
      }
    })();
    return true;
  }

  // ── Fetch cancelled ──
  if (msg.type === "fetch-cancelled") {
    (async () => {
      try {
        let allItems = [];
        const platforms = msg.platforms || { vinted: true, ebay: false };

        if (platforms.vinted) {
          const vintedItems = await fetchVintedCancelled();
          allItems.push(...vintedItems);
        }

        if (platforms.ebay) {
          const ebayItems = await fetchEbayCancelled();
          allItems.push(...ebayItems);
        }

        const { syncHistory = [] } = await chrome.storage.local.get({ syncHistory: [] });
        const historyKeys = buildRecentHistoryKeys(syncHistory);
        const newItems = allItems.filter((i) => {
          const platform = i.source || "vinted";
          return !historyKeys.has(`${platform}:${i.transaction_id}`);
        });
        sendResponse({ items: newItems });
      } catch (err) {
        sendResponse({ items: [], error: err.message });
      }
    })();
    return true;
  }

  // ── Resume sync ──
  if (msg.type === "resume-sync") {
    (async () => {
      await stateReady;
      try {
        const items = syncState.pendingItems;
        if (!items || items.length === 0) {
          emitLog("No items to resume.", "warn");
          syncState.running = false;
          saveNow();
          chrome.runtime.sendMessage({ type: "sync-done", completed: true }).catch(() => {});
          return;
        }

        const { syncHistory = [] } = await chrome.storage.local.get({ syncHistory: [] });
        const historyKeys = buildRecentHistoryKeys(syncHistory);
        const remaining = items.filter((i) => !historyKeys.has(`${i.platform}:${i.id}`));

        if (remaining.length === 0) {
          emitLog("All items already synced. Nothing to resume.", "ok");
          syncState.running = false;
          syncState.pendingItems = [];
          saveNow();
          chrome.runtime.sendMessage({ type: "sync-done", completed: true }).catch(() => {});
          return;
        }

        syncState.running = true;
        syncState.pendingItems = remaining;
        syncState.synced = 0;
        syncState.errors = 0;
        syncState.logs = [];
        saveNow();

        emitCounts({ found: remaining.length, synced: 0, errors: 0 });
        emitLog(`Resuming sync: ${remaining.length} item(s) remaining.`);
        await sendToCrosslist(remaining);
      } catch (err) {
        emitLog(`Resume error: ${err.message}`, "error");
        syncState.running = false;
        saveNow();
        chrome.runtime.sendMessage({ type: "sync-done", completed: false }).catch(() => {});
      }
    })();
    return true;
  }

  // ── Retry errors ──
  if (msg.type === "retry-errors") {
    (async () => {
      await stateReady;
      try {
        const items = syncState.erroredItems || [];
        if (items.length === 0) {
          emitLog("No errored items to retry.", "warn");
          syncState.running = false;
          saveNow();
          chrome.runtime.sendMessage({ type: "sync-done", completed: true }).catch(() => {});
          return;
        }

        // Filter out items that were manually resolved (now in syncHistory).
        const { syncHistory = [] } = await chrome.storage.local.get({ syncHistory: [] });
        const historyKeys = buildRecentHistoryKeys(syncHistory);
        const remaining = items.filter((i) => !historyKeys.has(`${i.platform}:${i.id}`));

        // Bug #7: Keep erroredItems until sync-done with completed:true confirms
        // everything finished — prevents item loss if user stops mid-retry.
        const retryItems = [...remaining];
        syncState = {
          running: true,
          found: 0,
          synced: 0,
          errors: 0,
          logs: [],
          pendingItems: retryItems,
          erroredItems: retryItems, // Keep until completed.
        };
        saveNow();

        if (remaining.length === 0) {
          emitLog("All errored items have since been resolved.", "ok");
          syncState.running = false;
          syncState.erroredItems = [];
          saveNow();
          chrome.runtime.sendMessage({ type: "sync-done", completed: true }).catch(() => {});
          return;
        }

        emitCounts({ found: remaining.length, synced: 0, errors: 0 });
        emitLog(`Retrying ${remaining.length} errored item(s)...`);
        await sendToCrosslist(remaining);
      } catch (err) {
        emitLog(`Retry error: ${err.message}`, "error");
        syncState.running = false;
        saveNow();
        chrome.runtime.sendMessage({ type: "sync-done", completed: false }).catch(() => {});
      }
    })();
    return true;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-sync via chrome.alarms — enabled/disabled from the popup settings.
// ─────────────────────────────────────────────────────────────────────────────

const AUTO_SYNC_ALARM = "auto-sync";
const AUTO_SYNC_DEFAULT_MINUTES = 30;

// Set up or tear down the alarm based on the stored setting.
async function applyAutoSyncSetting() {
  const { autoSync } = await chrome.storage.local.get({ autoSync: false });
  if (autoSync) {
    chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: AUTO_SYNC_DEFAULT_MINUTES });
  } else {
    chrome.alarms.clear(AUTO_SYNC_ALARM);
  }
}

// Apply on startup.
applyAutoSyncSetting();

// Re-apply whenever the setting changes (e.g. user toggles in popup).
chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoSync) applyAutoSyncSetting();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_SYNC_ALARM) return;
  // Only fire if not already syncing.
  if (syncState.running) return;
  const { vintedUserId, autoSync } = await chrome.storage.local.get(["vintedUserId", "autoSync"]);
  if (!autoSync || !vintedUserId) return;
  // Trigger a "latest" sync for both platforms.
  chrome.runtime.sendMessage({
    type: "start-sync",
    mode: "latest",
    platforms: { vinted: true, ebay: true },
    vintedUserId,
  }).catch(() => {});
});

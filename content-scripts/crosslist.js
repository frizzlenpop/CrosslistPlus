// content-scripts/crosslist.js — Runs on app.crosslist.com.
// Receives an array of { platform, id, title, sku, status } from the service
// worker and automates the Crosslist UI to mark each item as sold or delisted.
//
// ─────────────────────────────────────────────────────────────────────────────
// Crosslist DOM structure (verified March 2026):
//
//   Search bar:   <input placeholder="Search a listing">   (inside My Listings)
//   Table:        <table> with <thead> columns:
//                   [checkbox] [img] SKU | Title | Price | Created | Origin | Listed on | Sold | Labels | Actions
//   Each row:     <tr> → <td> cells matching the columns above
//   Sold toggle:  The "Sold" column contains a <checkbox> per row.
//                 Checking it marks the listing as sold in Crosslist.
//   Delist btn:   Per-row <button> with aria-label or text "delist".
//
// ⚠️  Crosslist can change their UI at any time. If selectors break,
//     right-click → Inspect the elements and update SELECTORS below.
// ─────────────────────────────────────────────────────────────────────────────

// Guard against double injection.
if (window.__crosslistSyncLoaded) {
    console.log("[InventorySync] Content script already loaded, skipping.");
} else {
    window.__crosslistSyncLoaded = true;

const SELECTORS = {
  // The search input on the "My listings" page.
  searchInput: 'input[placeholder*="Search a listing"]',

  // Table body rows (each listing is a <tr> inside <tbody>).
  listingRow: "table tbody tr",

  // The "Sold" checkbox is the 9th column (index 8) in each row.
  // It's an <input type="checkbox"> inside the Sold <td>.
  // We identify the Sold column by its position relative to the header.
  // Fallback: find the checkbox that is NOT the first cell's row-select checkbox.
  soldCheckboxIndex: 8, // 0-based column index for the Sold checkbox

  // Per-row "delist" button — used for canceled items.
  delistButton: 'button[aria-label="delist"], button:has(img)',
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wait for an element matching `selector` to appear in the DOM.
 */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timed out waiting for: ${selector}`));
    }, timeout);

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(found);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Simulate typing into an input so React registers the value change.
 *
 * React overrides the native `value` setter.  We call the original setter
 * from HTMLInputElement.prototype, then dispatch `input` with bubbles: true.
 */
async function simulateTyping(inputEl, text) {
  inputEl.focus();
  inputEl.dispatchEvent(new FocusEvent("focus", { bubbles: true }));

  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;

  // Clear the field.
  if (nativeSetter) {
    nativeSetter.call(inputEl, "");
  } else {
    inputEl.value = "";
  }
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));

  // Type each character with a short realistic delay.
  for (const char of text) {
    inputEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: char, bubbles: true })
    );

    const currentVal = inputEl.value + char;
    if (nativeSetter) {
      nativeSetter.call(inputEl, currentVal);
    } else {
      inputEl.value = currentVal;
    }

    inputEl.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: char,
        inputType: "insertText",
      })
    );
    inputEl.dispatchEvent(
      new KeyboardEvent("keyup", { key: char, bubbles: true })
    );

    await sleep(30 + Math.random() * 50);
  }

  inputEl.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Click an element with the full pointer + mouse event sequence.
 */
function simulateClick(el) {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  // Use native .click() instead of synthetic MouseEvent — this properly
  // toggles checkbox state + fires the change event that React needs
  // for controlled inputs (like the Sold checkbox).
  el.click();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function report(text, level = "info") {
  chrome.runtime.sendMessage({ type: "sync-log", text, level }).catch(() => {});
}

function reportCounts(counts) {
  chrome.runtime.sendMessage({ type: "sync-counts", ...counts }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Crosslist table helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the column index for "Sold" by reading the <thead> header row.
 * Returns a 0-based index, or -1 if not found.
 */
function findSoldColumnIndex() {
  const headers = document.querySelectorAll("table thead th, table thead td");
  for (let i = 0; i < headers.length; i++) {
    const text = headers[i].textContent.trim().toLowerCase();
    if (text === "sold") return i;
  }
  return SELECTORS.soldCheckboxIndex; // fallback to hardcoded
}

/**
 * Find the column index for "Title" by reading the <thead> header row.
 * Returns a 0-based index, or 3 if not found (hardcoded fallback).
 */
function findTitleColumnIndex() {
  const headers = document.querySelectorAll("table thead th, table thead td");
  for (let i = 0; i < headers.length; i++) {
    const text = headers[i].textContent.trim().toLowerCase();
    if (text === "title") return i;
  }
  return 3; // fallback to hardcoded
}

/**
 * Get the "Sold" checkbox from a table row.
 */
function getSoldCheckbox(row) {
  const soldIdx = findSoldColumnIndex();
  const cells = row.querySelectorAll("td");
  if (soldIdx >= 0 && soldIdx < cells.length) {
    const cb = cells[soldIdx].querySelector('input[type="checkbox"]');
    if (cb) return cb;
  }
  // Fallback: find a checkbox that isn't the first-cell row-select checkbox.
  const allCheckboxes = row.querySelectorAll('input[type="checkbox"]');
  if (allCheckboxes.length >= 2) return allCheckboxes[1];
  return null;
}

/**
 * Get the "delist" button from a row's actions cell (last cell).
 */
function getDelistButton(row) {
  const buttons = row.querySelectorAll("button");
  for (const btn of buttons) {
    const label = (
      btn.getAttribute("aria-label") ||
      btn.textContent ||
      ""
    ).toLowerCase();
    if (label.includes("delist")) return btn;
  }
  return null;
}

/**
 * Read the title text from a row.  Title column is resolved dynamically
 * from the <thead> header row, falling back to index 3.
 */
function getRowTitle(row) {
  const titleIdx = findTitleColumnIndex();
  const cells = row.querySelectorAll("td");
  if (titleIdx >= 0 && titleIdx < cells.length) return cells[titleIdx].textContent.trim();
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Abort flag — set by "stop-sync" message to halt processing after current item.
// ─────────────────────────────────────────────────────────────────────────────

let abortSync = false;
let syncGeneration = 0; // Incremented each time processItems is called

// ─────────────────────────────────────────────────────────────────────────────
// Notification dismissal — close toasts and lingering dialogs after delist.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dismiss any PrimeVue toast messages and lingering dialogs so they don't
 * stack up when processing multiple items in sequence.
 */
async function dismissNotifications() {
  // 1. Close PrimeVue dialog buttons — the "Delisting in progress" dialog
  //    uses <span class="p-button-label">Close</span> inside a <button>.
  const pvButtons = document.querySelectorAll("button");
  for (const btn of pvButtons) {
    const label = btn.querySelector(".p-button-label");
    if (label && label.textContent.trim().toLowerCase() === "close") {
      try { btn.click(); } catch (_) {}
    }
  }

  // 2. Close PrimeVue toast messages (each has a close button).
  const toastCloseButtons = document.querySelectorAll(
    ".p-toast-message .p-toast-icon-close, " +
    ".p-toast-message button[aria-label='Close'], " +
    ".p-toast-message-icon + button"
  );
  for (const btn of toastCloseButtons) {
    try { btn.click(); } catch (_) {}
  }

  // 3. Dismiss any lingering dialogs (e.g. warnings, confirmations).
  const openDialogs = document.querySelectorAll("dialog[open], dialog");
  for (const dlg of openDialogs) {
    const closeBtn = dlg.querySelector(
      'button[aria-label="Close"], ' +
      'button[aria-label="close"]'
    ) || [...dlg.querySelectorAll("button")].find(
      (b) => /^(close|ok|cancel|got it|dismiss)$/i.test(b.textContent.trim())
    );
    if (closeBtn) {
      try { closeBtn.click(); } catch (_) {}
    }
  }

  // Brief pause to let dismiss animations complete.
  await sleep(300);
}

// ─────────────────────────────────────────────────────────────────────────────
// Delist flow — handles the "Select marketplaces" dialog.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Click a row's delist button, interact with the marketplace dialog that
 * appears ("Delist everywhere"), and wait for the dialog to close.
 * Returns true on success, false on timeout/failure.
 */
async function performDelist(row) {
  const delistBtn = getDelistButton(row);
  if (!delistBtn) return false;

  simulateClick(delistBtn);

  // Wait for the dialog to appear (up to 8 seconds).
  let dialog = null;
  for (let i = 0; i < 80; i++) {
    dialog = document.querySelector("dialog[open]") ||
             document.querySelector("dialog") ||
             document.querySelector('[role="dialog"]');
    if (dialog) break;
    await sleep(100);
  }

  if (!dialog) {
    // No dialog appeared — maybe the item was already delisted or the UI
    // handled it inline.  Give it a moment and return success.
    await sleep(800);
    return true;
  }

  // Small pause to let the dialog fully render its buttons.
  await sleep(400);

  // Find and click "Delist everywhere" inside the dialog.
  let delistEverywhereBtn = null;
  const buttons = dialog.querySelectorAll("button");
  for (const btn of buttons) {
    const btnText = btn.textContent.trim().toLowerCase();
    if (btnText.includes("delist everywhere")) {
      delistEverywhereBtn = btn;
      break;
    }
  }

  if (!delistEverywhereBtn) {
    // Retry — the button might be in a child element outside direct dialog query.
    const allButtons = document.querySelectorAll("dialog button, [role='dialog'] button");
    for (const btn of allButtons) {
      if (btn.textContent.trim().toLowerCase().includes("delist everywhere")) {
        delistEverywhereBtn = btn;
        break;
      }
    }
  }

  if (!delistEverywhereBtn) {
    // Dialog opened but no "Delist everywhere" button found — close and bail.
    report("  Could not find 'Delist everywhere' button in dialog.", "warn");
    const cancelBtn = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent.trim().toLowerCase() === "cancel"
    );
    if (cancelBtn) simulateClick(cancelBtn);
    await sleep(500);
    return false;
  }

  simulateClick(delistEverywhereBtn);

  // Delisting runs in the background on Crosslist's side — no need to wait
  // for it to finish.  Just dismiss the progress dialog so it doesn't block
  // the next item, then move on immediately.
  await sleep(1500);

  // Try to close the progress dialog — click Close if it's already available,
  // otherwise dismiss whatever is showing.
  await dismissNotifications();

  await sleep(500);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination helper — tries up to maxPages "next page" clicks to find a row.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to find a matching row by clicking the "next page" button up to
 * maxPages times.  Returns the matched row element, or null if not found.
 *
 * @param {string} searchTitle - Lowercased title string to match against.
 * @param {number} [maxPages=3] - Maximum number of additional pages to check.
 * @returns {Promise<Element|null>}
 */
async function tryNextPages(searchTitle, maxPages = 3) {
  for (let p = 0; p < maxPages; p++) {
    const nextBtn = document.querySelector('button[aria-label="Next page"], button.p-paginator-next:not([disabled])');
    if (!nextBtn) return null;

    simulateClick(nextBtn);
    await sleep(1500);

    const rows = document.querySelectorAll(SELECTORS.listingRow);
    for (const row of rows) {
      const rowTitle = getRowTitle(row).toLowerCase();
      if (rowTitle.includes(searchTitle) || searchTitle.includes(rowTitle)) {
        return row;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core sync logic — processes items one-by-one.
// ─────────────────────────────────────────────────────────────────────────────

async function processItems(items) {
  abortSync = false;
  syncGeneration++;
  const myGeneration = syncGeneration;
  let synced = 0;
  let errors = 0;

  for (const item of items) {
    if (abortSync || myGeneration !== syncGeneration) {
      report("Sync stopped.", "warn");
      break;
    }

    try {
      report(`[${item.platform}] Searching for "${item.title}"...`);

      // 1. Search by SKU first if available, then fall back to title.
      const searchInput = await waitForElement(SELECTORS.searchInput);
      let searchTerm = item.title;
      let matchedRow = null;

      if (item.sku) {
        report(`  Trying SKU search: "${item.sku}"...`);
        await simulateTyping(searchInput, item.sku);
        await sleep(1500);

        const skuRows = document.querySelectorAll(SELECTORS.listingRow);
        for (const row of skuRows) {
          // Check SKU column (index 2) for exact match.
          const cells = row.querySelectorAll("td");
          if (cells.length > 2) {
            const rowSku = cells[2].textContent.trim();
            if (rowSku === item.sku) {
              matchedRow = row;
              break;
            }
          }
        }

        if (!matchedRow && skuRows.length === 1) {
          matchedRow = skuRows[0]; // Only one result — take it.
        }

        if (!matchedRow) {
          report(`  SKU not found, falling back to title search...`);
          await clearSearch(searchInput);
        }
      }

      if (!matchedRow) {
        await simulateTyping(searchInput, item.title);
        await sleep(1500);

        const rows = document.querySelectorAll(SELECTORS.listingRow);
        for (const row of rows) {
          const rowTitle = getRowTitle(row).toLowerCase();
          const searchTitle = item.title.toLowerCase();
          if (rowTitle.includes(searchTitle) || searchTitle.includes(rowTitle)) {
            matchedRow = row;
            break;
          }
        }

        if (!matchedRow && rows.length > 0) {
          matchedRow = rows[0];
        }
      }

      // If still no match, try paginating through additional result pages.
      if (!matchedRow) {
        matchedRow = await tryNextPages(item.title.toLowerCase());
      }

      if (!matchedRow) {
        report(`  No listing found for "${item.title}".`, "warn");
        errors++;
        reportCounts({ errors });
        chrome.runtime.sendMessage({ type: "sync-error-entry", item }).catch(() => {});
        await clearSearch(searchInput);
        continue;
      }

      // 3. Mark the item based on status.
      if (item.status === "sold") {
        let markedSold = false;
        let didDelist = false;

        // a) Check the "Sold" checkbox — but NEVER uncheck one that's already sold.
        const soldCb = getSoldCheckbox(matchedRow);
        if (soldCb) {
          if (soldCb.checked) {
            // Already sold — do NOT touch the checkbox. Just ensure it's delisted below.
            report(`  "${item.title}" already marked as sold — checking delist status.`, "info");
            markedSold = true;
          } else {
            simulateClick(soldCb);
            // Wait for React to re-render the row after checkbox change.
            await sleep(1200);
            // Verify it actually got checked (guard against accidental uncheck).
            const verifiedCb = getSoldCheckbox(matchedRow);
            if (verifiedCb && verifiedCb.checked) {
              report(`  Marked "${item.title}" as sold.`, "ok");
              markedSold = true;
            } else {
              report(`  Sold checkbox click may not have registered for "${item.title}".`, "warn");
              // Don't retry — safer to leave it and let the user handle manually.
            }
          }
        } else {
          report(`  Could not find Sold checkbox for "${item.title}".`, "warn");
        }

        // b) Also delist the item so it's removed from active listings.
        //    Re-query the row in case React re-rendered after the sold toggle.
        let freshRow = matchedRow;
        const freshRows = document.querySelectorAll(SELECTORS.listingRow);
        for (const r of freshRows) {
          const t = getRowTitle(r).toLowerCase();
          const searchTitle = item.title.toLowerCase();
          if (t.includes(searchTitle) || searchTitle.includes(t)) {
            freshRow = r;
            break;
          }
        }

        if (getDelistButton(freshRow)) {
          const ok = await performDelist(freshRow);
          if (ok) {
            report(`  Delisted "${item.title}".`, "ok");
            didDelist = true;
          } else {
            report(`  Delist dialog failed for "${item.title}".`, "warn");
          }
        } else {
          report(`  No delist button for "${item.title}" (may already be delisted).`, "info");
        }

        // Count as synced if we at least marked it sold (delist is best-effort).
        if (markedSold) {
          synced++;
          const action = didDelist ? "sold+delisted" : "sold";
          chrome.runtime.sendMessage({
            type: "sync-history-entry",
            entry: { platform: item.platform, id: item.id, title: item.title, status: item.status, action, timestamp: Date.now() },
          }).catch(() => {});
        } else if (!markedSold && soldCb && soldCb.checked && !getDelistButton(freshRow)) {
          // Already sold + already delisted — skip gracefully.
          report(`  "${item.title}" already fully processed.`, "info");
          synced++;
          chrome.runtime.sendMessage({
            type: "sync-history-entry",
            entry: { platform: item.platform, id: item.id, title: item.title, status: item.status, action: "sold+delisted", timestamp: Date.now() },
          }).catch(() => {});
        } else {
          errors++;
          chrome.runtime.sendMessage({ type: "sync-error-entry", item }).catch(() => {});
        }

      } else if (item.status === "canceled") {
        // For canceled items, just delist (no sold checkbox).
        if (getDelistButton(matchedRow)) {
          const ok = await performDelist(matchedRow);
          if (ok) {
            report(`  Delisted "${item.title}".`, "ok");
            synced++;
            chrome.runtime.sendMessage({
              type: "sync-history-entry",
              entry: { platform: item.platform, id: item.id, title: item.title, status: item.status, action: "delisted", timestamp: Date.now() },
            }).catch(() => {});
          } else {
            report(`  Delist dialog failed for "${item.title}".`, "error");
            errors++;
            chrome.runtime.sendMessage({ type: "sync-error-entry", item }).catch(() => {});
          }
        } else {
          report(`  No delist button for "${item.title}" (may already be delisted).`, "info");
          synced++;
          chrome.runtime.sendMessage({
            type: "sync-history-entry",
            entry: { platform: item.platform, id: item.id, title: item.title, status: item.status, action: "delisted", timestamp: Date.now() },
          }).catch(() => {});
        }
      }

      reportCounts({ synced, errors });

      // 4. Clear the search for the next item.
      await clearSearch(searchInput);

    } catch (err) {
      report(`  Error processing "${item.title}": ${err.message}`, "error");
      errors++;
      reportCounts({ errors });
      chrome.runtime.sendMessage({ type: "sync-error-entry", item }).catch(() => {});
    }
  }

  const wasAborted = abortSync;
  report(
    wasAborted
      ? `Stopped. ${synced} synced, ${errors} error(s). You can resume from the popup.`
      : `Done. ${synced} synced, ${errors} error(s).`,
    synced > 0 ? "ok" : "warn"
  );
  reportCounts({ synced, errors });
  chrome.runtime.sendMessage({ type: "sync-done", completed: !wasAborted }).catch(() => {});
}

async function clearSearch(searchInput) {
  const el = searchInput || document.querySelector(SELECTORS.searchInput);
  if (el) {
    await simulateTyping(el, "");
    await sleep(800);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message listener — the service worker sends { type: "sync-items", items }.
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "stop-sync") {
    abortSync = true;
    sendResponse({ ok: true });
    return;
  }

  if (msg.type !== "sync-items") return;

  report(`Received ${msg.items.length} item(s) to process in Crosslist.`);
  processItems(msg.items);
  sendResponse({ ok: true });
});

console.log("[InventorySync] Crosslist content script loaded.");

} // end of double-injection guard

// popup/popup.js — Drives the popup UI and communicates with the service worker.

const $ = (sel) => document.querySelector(sel);
const logsEl    = $("#logs");
const btnSync     = $("#btn-sync");
const btnFullSync = $("#btn-full-sync");
const btnStop     = $("#btn-stop");
const btnResume   = $("#btn-resume");
const btnRetry    = $("#btn-retry");
const countFound  = $("#count-found");
const countSynced = $("#count-synced");
const countErrors = $("#count-errors");
const vintedIdInput = $("#vinted-user-id");
const syncView    = $("#sync-view");
const historyView = $("#history-view");
const historyList = $("#history-list");
const btnClearHistory = $("#btn-clear-history");
const reviewView       = $("#review-view");
const btnFetchCancelled = $("#btn-fetch-cancelled");
const cancelledList    = $("#cancelled-list");
const reviewFooter     = $("#review-footer");
const chkSelectAll     = $("#chk-select-all");
const btnSyncCancelled = $("#btn-sync-cancelled");

// ── Logging helpers ──────────────────────────────────────────────────────────

function log(text, level = "info") {
  const line = document.createElement("div");
  line.className = `log-line ${level}`;
  line.textContent = text;
  logsEl.appendChild(line);
  logsEl.scrollTop = logsEl.scrollHeight;
}

function clearLogs() {
  logsEl.innerHTML = "";
  countFound.textContent  = "0";
  countSynced.textContent = "0";
  countErrors.textContent = "0";
}

// ── Platform toggle interaction ──────────────────────────────────────────────

document.querySelectorAll(".platform-toggle").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const cb = toggle.querySelector("input[type=checkbox]");
    cb.checked = !cb.checked;
    toggle.classList.toggle("active", cb.checked);
  });
});

// ── Persist / restore Vinted user ID ─────────────────────────────────────────

chrome.storage.local.get(["vintedUserId"], (data) => {
  if (data.vintedUserId) vintedIdInput.value = data.vintedUserId;
});

vintedIdInput.addEventListener("change", () => {
  chrome.storage.local.set({ vintedUserId: vintedIdInput.value.trim() });
});

// ── Restore sync state from previous session ─────────────────────────────────
// The popup closes whenever the user switches tabs (e.g. to Crosslist).
// On re-open, we restore counters, logs, and button states from persisted state.

chrome.runtime.sendMessage({ type: "get-sync-state" }, (state) => {
  if (chrome.runtime.lastError || !state) return;

  // Restore counters.
  countFound.textContent  = state.found  || 0;
  countSynced.textContent = state.synced || 0;
  countErrors.textContent = state.errors || 0;

  // Replay logs.
  for (const entry of (state.logs || [])) {
    log(entry.text, entry.level);
  }

  if (state.running) {
    // Sync is still in progress — show stop button.
    btnSync.style.display = "none";
    btnFullSync.style.display = "none";
    btnResume.style.display = "none";
    btnRetry.style.display = "none";
    btnStop.style.display = "block";
  } else if (state.pendingItems && state.pendingItems.length > 0) {
    // Sync was stopped with items remaining — show resume button.
    chrome.storage.local.get({ syncHistory: [] }, (data) => {
      const historyKeys = new Set((data.syncHistory || []).map((e) => `${e.platform}:${e.id}`));
      const remaining = state.pendingItems.filter((i) => !historyKeys.has(`${i.platform}:${i.id}`));
      if (remaining.length > 0) {
        btnResume.textContent = `Resume Sync (${remaining.length} left)`;
        btnResume.style.display = "block";
      }
    });
  }

  // Show retry button if there are errored items and sync is not running.
  if (!state.running && state.erroredItems && state.erroredItems.length > 0) {
    btnRetry.textContent = `Retry Errors (${state.erroredItems.length})`;
    btnRetry.style.display = "block";
  }
});

// ── Listen for progress messages from the service worker ─────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "sync-log") {
    log(msg.text, msg.level || "info");
  }
  if (msg.type === "sync-counts") {
    countFound.textContent  = msg.found  ?? countFound.textContent;
    countSynced.textContent = msg.synced ?? countSynced.textContent;
    countErrors.textContent = msg.errors ?? countErrors.textContent;
  }
  if (msg.type === "sync-done") {
    btnStop.style.display = "none";
    btnStop.disabled = false;
    btnStop.textContent = "Stop Sync";
    btnSync.style.display = "";
    btnSync.disabled = false;
    btnSync.textContent = "Sync Latest";
    btnFullSync.style.display = "";
    btnFullSync.disabled = false;
    btnFullSync.textContent = "Full Sync";

    if (msg.completed) {
      btnResume.style.display = "none";
      log("Sync complete.", "ok");
    } else {
      log("Sync stopped.", "warn");
      // Check if there are remaining items for resume.
      chrome.runtime.sendMessage({ type: "get-sync-state" }, (state) => {
        if (chrome.runtime.lastError || !state) return;
        if (state.pendingItems && state.pendingItems.length > 0) {
          chrome.storage.local.get({ syncHistory: [] }, (data) => {
            const historyKeys = new Set((data.syncHistory || []).map((e) => `${e.platform}:${e.id}`));
            const remaining = state.pendingItems.filter((i) => !historyKeys.has(`${i.platform}:${i.id}`));
            if (remaining.length > 0) {
              btnResume.textContent = `Resume Sync (${remaining.length} left)`;
              btnResume.style.display = "block";
            }
          });
        }
      });
    }

    // Show retry button if there are errored items.
    chrome.runtime.sendMessage({ type: "get-sync-state" }, (state) => {
      if (chrome.runtime.lastError || !state) return;
      if (state.erroredItems && state.erroredItems.length > 0) {
        btnRetry.textContent = `Retry Errors (${state.erroredItems.length})`;
        btnRetry.style.display = "block";
      } else {
        btnRetry.style.display = "none";
      }
    });
  }
});

// ── Sync button click handlers ──────────────────────────────────────────────

function startSync(mode) {
  clearLogs();

  const enableVinted = $('[data-platform="vinted"]').classList.contains("active");
  const enableEbay   = $('[data-platform="ebay"]').classList.contains("active");

  if (!enableVinted && !enableEbay) {
    log("Enable at least one platform.", "warn");
    return;
  }

  const vintedUserId = vintedIdInput.value.trim();
  if (enableVinted && !vintedUserId) {
    log("Please enter your Vinted user ID first.", "warn");
    return;
  }

  // Save the ID for next time.
  chrome.storage.local.set({ vintedUserId });

  btnSync.style.display = "none";
  btnFullSync.style.display = "none";
  btnResume.style.display = "none";
  btnRetry.style.display = "none";
  btnStop.style.display = "block";
  log(mode === "full" ? "Starting full sync..." : "Starting sync (latest)...");

  // Tell the service worker to begin.
  chrome.runtime.sendMessage({
    type: "start-sync",
    mode,
    platforms: {
      vinted: enableVinted,
      ebay: enableEbay,
    },
    vintedUserId,
  });
}

btnSync.addEventListener("click", () => startSync("latest"));
btnFullSync.addEventListener("click", () => startSync("full"));

// ── Stop button click handler ────────────────────────────────────────────────

btnStop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop-sync" });
  btnStop.disabled = true;
  btnStop.textContent = "Stopping...";
  log("Stopping sync...", "warn");
});

// ── Resume button click handler ──────────────────────────────────────────────

btnResume.addEventListener("click", () => {
  clearLogs();
  btnResume.style.display = "none";
  btnRetry.style.display = "none";
  btnSync.style.display = "none";
  btnFullSync.style.display = "none";
  btnStop.style.display = "block";
  log("Resuming sync...");
  chrome.runtime.sendMessage({ type: "resume-sync" });
});

// ── Retry errors button click handler ────────────────────────────────────────

btnRetry.addEventListener("click", () => {
  clearLogs();
  btnRetry.style.display = "none";
  btnResume.style.display = "none";
  btnSync.style.display = "none";
  btnFullSync.style.display = "none";
  btnStop.style.display = "block";
  log("Retrying errored items...");
  chrome.runtime.sendMessage({ type: "retry-errors" });
});

// ── Tab switching ────────────────────────────────────────────────────────────

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    const tab = btn.dataset.tab;
    syncView.style.display    = tab === "sync"    ? "block" : "none";
    reviewView.style.display  = tab === "review"  ? "block" : "none";
    historyView.style.display = tab === "history" ? "block" : "none";

    if (tab === "history") renderHistory();
  });
});

// ── History rendering ────────────────────────────────────────────────────────

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function actionLabel(action) {
  if (action === "sold+delisted") return "Sold + Delisted";
  if (action === "delisted") return "Delisted";
  return "Sold";
}

function actionClass(action) {
  if (action === "sold+delisted") return "sold-delisted";
  if (action === "delisted") return "delisted";
  return "sold";
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function renderHistory() {
  chrome.storage.local.get({ syncHistory: [] }, (data) => {
    const history = data.syncHistory;
    historyList.innerHTML = "";

    if (history.length === 0) {
      historyList.innerHTML = '<div class="history-empty">No sync history yet.</div>';
      return;
    }

    // Show newest first.
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i];
      const title = esc(e.title);
      const div = document.createElement("div");
      div.className = "history-entry";
      div.innerHTML =
        `<span class="h-platform ${esc(e.platform)}">${esc(e.platform)}</span>` +
        `<div class="h-body">` +
          `<div class="h-title" title="${title}">${title}</div>` +
          `<div class="h-meta">${formatDate(e.timestamp)}</div>` +
        `</div>` +
        `<span class="h-action ${actionClass(e.action)}">${actionLabel(e.action)}</span>`;
      historyList.appendChild(div);
    }
  });
}

// ── Clear history ────────────────────────────────────────────────────────────

btnClearHistory.addEventListener("click", () => {
  chrome.storage.local.set({ syncHistory: [] }, () => {
    renderHistory();
  });
});

// ── Review: Fetch Cancelled Orders ──────────────────────────────────────────

let cancelledOrders = []; // Cached list from last fetch.

btnFetchCancelled.addEventListener("click", () => {
  btnFetchCancelled.disabled = true;
  btnFetchCancelled.textContent = "Fetching...";
  cancelledList.innerHTML = '<div class="cancelled-empty">Loading cancelled orders...</div>';
  reviewFooter.style.display = "none";

  chrome.runtime.sendMessage({ type: "fetch-cancelled" }, (response) => {
    btnFetchCancelled.disabled = false;
    btnFetchCancelled.textContent = "Fetch Cancelled Orders";

    if (chrome.runtime.lastError) {
      cancelledList.innerHTML = `<div class="cancelled-empty">Error: ${chrome.runtime.lastError.message}</div>`;
      return;
    }

    if (!response || !response.items || response.items.length === 0) {
      cancelledList.innerHTML = '<div class="cancelled-empty">No new cancelled orders found.</div>';
      return;
    }

    cancelledOrders = response.items;
    renderCancelledOrders();
  });
});

function renderCancelledOrders() {
  cancelledList.innerHTML = "";

  for (const order of cancelledOrders) {
    const card = document.createElement("div");
    card.className = "cancelled-card selected";
    card.dataset.transactionId = order.transaction_id;

    const thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.src = order.photoUrl || "";
    thumb.alt = "";
    thumb.onerror = () => { thumb.style.display = "none"; };

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML =
      `<div class="c-title" title="${esc(order.title)}">${esc(order.title)}</div>` +
      `<div class="c-meta">${esc(order.price)} &middot; ${esc(formatDate(order.date))}</div>` +
      `<div class="c-reason">${esc(order.status)}</div>`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "c-check";
    checkbox.checked = true;

    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      card.classList.toggle("selected", checkbox.checked);
      updateSyncButtonCount();
    });

    card.addEventListener("click", (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      card.classList.toggle("selected", checkbox.checked);
      updateSyncButtonCount();
    });

    card.appendChild(thumb);
    card.appendChild(info);
    card.appendChild(checkbox);
    cancelledList.appendChild(card);
  }

  reviewFooter.style.display = "flex";
  chkSelectAll.checked = true;
  updateSyncButtonCount();
}

function getSelectedCount() {
  return cancelledList.querySelectorAll(".c-check:checked").length;
}

function updateSyncButtonCount() {
  const count = getSelectedCount();
  btnSyncCancelled.disabled = count === 0;
  btnSyncCancelled.innerHTML = count > 0
    ? `Sync Selected to Crosslist <span class="badge-count">${count}</span>`
    : "Sync Selected to Crosslist";

  // Update select-all state.
  const total = cancelledList.querySelectorAll(".c-check").length;
  chkSelectAll.checked = count === total;
}

// ── Review: Select All toggle ───────────────────────────────────────────────

chkSelectAll.addEventListener("change", () => {
  const checked = chkSelectAll.checked;
  cancelledList.querySelectorAll(".c-check").forEach((cb) => {
    cb.checked = checked;
    cb.closest(".cancelled-card").classList.toggle("selected", checked);
  });
  updateSyncButtonCount();
});

// ── Review: Sync Selected ───────────────────────────────────────────────────

btnSyncCancelled.addEventListener("click", () => {
  const selectedCards = cancelledList.querySelectorAll(".cancelled-card.selected");
  if (selectedCards.length === 0) return;

  const items = [];
  for (const card of selectedCards) {
    const tid = card.dataset.transactionId;
    const order = cancelledOrders.find((o) => String(o.transaction_id) === tid);
    if (order) {
      items.push({
        platform: "vinted",
        id: String(order.transaction_id),
        title: order.title,
        sku: "",
        status: "sold", // Mark as sold so Crosslist marks sold + delists.
      });
    }
  }

  // Send to service worker for syncing.
  chrome.runtime.sendMessage({ type: "sync-manual-items", items });

  // Switch to Sync tab to show progress (keep existing logs).
  if (logsEl.childNodes.length > 0) {
    log("────────────────────────────────", "info");
  }
  log(`Syncing ${items.length} cancelled order(s)...`);
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector('[data-tab="sync"]').classList.add("active");
  syncView.style.display = "block";
  reviewView.style.display = "none";
  historyView.style.display = "none";

  btnSync.style.display = "none";
  btnFullSync.style.display = "none";
  btnResume.style.display = "none";
  btnRetry.style.display = "none";
  btnStop.style.display = "block";
});

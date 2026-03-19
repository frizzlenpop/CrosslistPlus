# CrosslistPlus

**Automatically sync your sold and cancelled items from Vinted and eBay into Crosslist** — so you don't have to manually mark each one as sold and delist it.

If you sell on multiple platforms and use [Crosslist](https://crosslist.com) to manage your listings, this extension saves you the tedious work of updating Crosslist every time something sells or gets cancelled. It reads your recent sales, finds the matching listing in Crosslist, ticks the "Sold" checkbox, and clicks "Delist" — all automatically.

---

## Table of Contents

1. [What You Need Before Starting](#what-you-need-before-starting)
2. [How to Download CrosslistPlus](#how-to-download-crosslistplus)
3. [How to Install the Extension in Chrome](#how-to-install-the-extension-in-chrome)
4. [First-Time Setup](#first-time-setup)
5. [How to Use It](#how-to-use-it)
   - [Sync Tab](#sync-tab)
   - [Review Tab](#review-tab)
   - [History Tab](#history-tab)
   - [Settings](#settings)
6. [Understanding the Buttons](#understanding-the-buttons)
7. [Frequently Asked Questions](#frequently-asked-questions)
8. [Troubleshooting](#troubleshooting)

---

## What You Need Before Starting

- **Google Chrome** (or any Chromium-based browser like Edge or Brave)
- An active account on **Crosslist** (you must be able to log in at [app.crosslist.com](https://app.crosslist.com))
- An active account on **Vinted** and/or **eBay** (whichever platforms you sell on)
- All three sites must be logged in within Chrome — the extension uses your existing browser sessions to access your data. It does not store or transmit your passwords.

---

## How to Download CrosslistPlus

1. Go to the CrosslistPlus page on GitHub:
   **https://github.com/frizzlenpop/CrosslistPlus**

2. Click the green **"Code"** button near the top-right of the page.

3. In the dropdown that appears, click **"Download ZIP"**.

4. A file called `CrosslistPlus-master.zip` will download to your computer (usually to your Downloads folder).

5. **Extract (unzip) the file:**
   - **Windows:** Right-click the ZIP file and choose **"Extract All..."**, then click **Extract**.
   - **Mac:** Double-click the ZIP file and it will automatically unzip.

6. You should now have a folder called `CrosslistPlus-master`. You can rename it or move it wherever you like — just remember where you put it, because Chrome will need to find it later.

---

## How to Install the Extension in Chrome

Chrome doesn't let you install extensions from outside the Chrome Web Store by default, but you can load them manually using "Developer mode". Here's how:

1. Open Chrome and type this into the address bar, then press Enter:
   ```
   chrome://extensions
   ```

2. In the top-right corner of the page, you'll see a toggle labelled **"Developer mode"**. Turn it **on** (it should turn blue).

3. Three new buttons will appear near the top of the page. Click the one that says **"Load unpacked"**.

4. A file picker window will open. Navigate to the `CrosslistPlus-master` folder you extracted earlier and select it (the folder that contains `manifest.json`).

5. The extension will now appear in your list of extensions. You should see **"Inventory Sync — eBay & Vinted → Crosslist"** with a small icon.

6. **Pin the extension** so it's always visible in your toolbar:
   - Click the puzzle piece icon in the top-right of Chrome (the Extensions menu).
   - Find "Inventory Sync" in the list and click the pin icon next to it.

You're now ready to use CrosslistPlus.

> **Important:** Don't delete or move the `CrosslistPlus-master` folder after loading it. Chrome reads the extension files from that folder. If you move or delete it, the extension will stop working. You'd need to re-load it from the new location.

---

## First-Time Setup

Before you can sync, you need to do a few quick things:

### 1. Log into your accounts

Make sure you are logged into all of the following in Chrome (in normal tabs, not incognito):
- **Vinted** — [www.vinted.co.uk](https://www.vinted.co.uk) (or your local Vinted site)
- **eBay** — [www.ebay.co.uk](https://www.ebay.co.uk) (or your local eBay site)
- **Crosslist** — [app.crosslist.com](https://app.crosslist.com)

### 2. Find your Vinted User ID

The extension needs your Vinted User ID (a number) to look up your sold items. Here's how to find it:

1. Go to Vinted and click on your profile.
2. Look at the URL in your browser's address bar. It will look something like:
   ```
   https://www.vinted.co.uk/member/123456789-yourname
   ```
3. The number before your name is your User ID. In this example, it's **123456789**.

### 3. Enter your User ID in the extension

1. Click the CrosslistPlus icon in your Chrome toolbar to open it.
2. You'll see a field labelled **"Vinted User ID"**. Type or paste your number there.
3. It will be saved automatically — you won't need to enter it again.

### 4. Choose your platforms

At the top of the extension popup, you'll see two toggles: **Vinted** and **eBay**. Both are enabled by default. If you only sell on one platform, click the other one to turn it off. You can change this at any time.

---

## How to Use It

Click the CrosslistPlus icon in your Chrome toolbar to open the popup. You'll see three tabs at the top: **Sync**, **Review**, and **History**.

### Sync Tab

This is the main screen where you sync your sold items into Crosslist.

#### Running a sync

1. Make sure your platforms are selected and your Vinted User ID is entered.
2. Click **"Sync Latest"** (the blue button). This fetches your most recent sold items.
3. The extension will:
   - Fetch your sold items from Vinted and/or eBay (only confirmed completed/shipped orders)
   - Open or switch to a Crosslist tab
   - Search for each item in Crosslist by SKU (if available) or title
   - Verify the match using title similarity scoring and SKU cross-checking — if the match is ambiguous (e.g. size variants), it skips the item rather than risk acting on the wrong one
   - Tick the "Sold" checkbox on matching listings
   - Click "Delist" to remove them from active marketplaces
4. You can watch the progress in the **Activity Log** at the bottom and the **Found / Synced / Errors** counters.

#### What happens during a sync

- The extension automates the Crosslist website on your behalf — you'll see it typing in the search box, clicking checkboxes, and clicking buttons. This is normal.
- **Don't click around in the Crosslist tab** while a sync is running. Let it finish first.
- The popup may close when the Crosslist tab activates — this is normal. Just click the extension icon again to reopen it and see the progress. All state is preserved.

#### Stopping and resuming

- Click **"Stop Sync"** at any time to pause. Any items not yet processed will be saved.
- When you reopen the extension, you'll see a green **"Resume Sync"** button that lets you continue where you left off.

#### Failed items

If some items fail during a sync (no matching listing found, checkbox didn't register, etc.), a red **"Failed Items"** section appears below the counters. Click it to expand and see which items failed and why. You can then use **"Retry Errors"** to re-attempt just those items, or **"Dismiss Errors"** to clear them.

#### Notifications

When a sync completes, you'll receive a Chrome desktop notification showing how many items were synced and how many errors occurred. This is especially useful with auto-sync, so you know when a background sync finishes.

### Review Tab

This tab is for **cancelled orders** from Vinted and/or eBay that need manual review before syncing.

Sometimes orders get cancelled (buyer didn't pay, item was returned, etc.). These items might still be listed on Crosslist and need to be delisted. The Review tab lets you:

1. Click **"Fetch Cancelled Orders"** to pull your cancelled orders from Vinted and/or eBay (depending on which platforms you have enabled).
2. A list of cancelled orders will appear, each with a platform badge (Vinted or eBay) and a checkbox.
3. Review the list — uncheck any items you don't want to delist.
4. Click **"Sync Selected to Crosslist"** to delist the checked items.

The extension will switch to the Sync tab and process them. Your previous sync logs are preserved — you won't lose your earlier results.

### History Tab

Every item that the extension successfully syncs is recorded here. The history shows:

- The item title
- Which platform it came from (Vinted or eBay)
- What action was taken (Sold, Delisted, or Sold + Delisted)
- The date and time

This is useful for keeping track of what's been done. Items in the history are automatically skipped in future syncs, so nothing gets processed twice. Each title is a clickable link that opens the original item on Vinted or eBay.

You can click **"Clear History"** to wipe the history. Note: if you clear history, those items may be re-processed in future syncs.

---

## Understanding the Buttons

| Button | Colour | What it does |
|---|---|---|
| **Sync Latest** | Blue | Fetches your most recent sold items (last page from Vinted, last 90 days from eBay) and syncs any that aren't already in your history. This is the button you'll use most often. |
| **Full Sync** | Grey outline | Fetches **all** your sold items across all time. Use this the first time you set up, or if you think some older items were missed. Takes longer than Sync Latest. |
| **Stop Sync** | Red | Stops the current sync. Items already processed are saved. Remaining items can be resumed later. |
| **Resume Sync** | Green | Appears after you stop a sync. Picks up where you left off without re-fetching items. |
| **Retry Errors** | Amber/Orange | Appears after a sync if some items failed (e.g. no matching listing found in Crosslist). Retries only the failed items without re-running the entire sync. |
| **Dismiss Errors** | Subtle/text | Clears the list of failed items without retrying them. Useful if you've manually resolved them or don't want to retry. |

---

## Frequently Asked Questions

### Is this safe? Does it access my passwords?

No. The extension never sees, stores, or transmits your passwords. It works by using your existing browser sessions — when you're logged into Vinted, eBay, and Crosslist in Chrome, your browser automatically includes session cookies with requests. The extension simply makes the same requests your browser would make if you navigated to those pages yourself.

### Do I need to keep the extension folder on my computer?

Yes. Chrome loads the extension directly from the folder on your computer. If you delete or move the folder, the extension will stop working. If you move it to a new location, you'll need to remove the extension from Chrome and re-load it from the new location.

### Can I use this on Firefox or Safari?

No, this is a Chrome extension (Manifest V3). It works on Chrome and other Chromium-based browsers like Microsoft Edge and Brave. It will not work on Firefox or Safari.

### What does "No listing found" mean?

This means the extension searched for an item's title in Crosslist but couldn't find a matching listing. This can happen if:
- The item title in Crosslist is very different from the one on Vinted/eBay
- The listing was already deleted from Crosslist
- Crosslist's search didn't return results for that title

You can use the **"Retry Errors"** button to try again, or manually mark it in Crosslist.

### What does "AMBIGUOUS match" mean?

This means the extension found two or more listings in Crosslist with very similar titles (e.g. size or colour variants of the same product) and couldn't tell which one is correct. Rather than risk acting on the wrong listing, it skips the item. If your items have SKUs set in Crosslist, the extension uses those to break the tie automatically. Otherwise, you'll need to mark the item manually.

### What if an item is returned and I relist it?

The extension tracks synced items for 30 days. If an item is returned and you relist it, and it sells again after 30 days, it will be picked up by the next sync. If it sells again within 30 days of the original sync, you'll need to process it manually or clear your history.

### What's the difference between "Sync Latest" and "Full Sync"?

- **Sync Latest** only looks at recent items — page 1 of your Vinted sold items (up to 50) and the last 90 days of eBay orders. It's fast and is what you'd use day-to-day.
- **Full Sync** fetches everything — all pages of Vinted sold items and all eBay orders across all time periods. It's thorough but slower. Use it for your first sync or occasionally to catch anything that might have been missed.

Both modes skip items that are already in your sync history.

### Settings

At the bottom of the Sync tab, you'll find two optional settings:

- **Auto-sync every 30 min** — When enabled, the extension will automatically run a "Sync Latest" every 30 minutes in the background. It uses your saved Vinted User ID and syncs both platforms. You'll get a notification when it finishes.
- **Dry Run (preview only)** — When enabled, clicking Sync Latest or Full Sync will fetch your items and show you what *would* happen in the Activity Log, without actually opening Crosslist or making any changes. Useful for checking what's pending before committing to a real sync.

### The popup closed! Did I lose my progress?

No. The popup closes automatically when the Crosslist tab activates (this is a Chrome limitation — extension popups close when you switch tabs). Just click the extension icon again to reopen it. All counters, logs, and progress are preserved.

### Can I run a sync while browsing other tabs?

The Crosslist tab needs to stay open because the extension automates actions on that page. You can use other tabs, but don't close or navigate away from the Crosslist tab while a sync is running.

### How do I update the extension?

1. Download the latest version from GitHub (same steps as the initial download).
2. Extract the ZIP, replacing the old folder.
3. Go to `chrome://extensions` and click the refresh icon on the CrosslistPlus extension card, or click **"Load unpacked"** again and select the updated folder.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| **"No sold items found (or not logged in)"** | Make sure you're logged into Vinted/eBay in Chrome. Try visiting the site in a normal tab and check you can see your account. |
| **Vinted returns errors** | Your session may have expired. Log out of Vinted and log back in, then try the sync again. |
| **eBay returns no items** | Make sure you're logged into eBay Seller Hub. Visit `ebay.co.uk/sh/ord` in a tab first and check you can see your orders. |
| **"No listing found" for every item** | The item titles in Crosslist may not match the titles on Vinted/eBay. The extension requires at least 60% word overlap to match. You may need to sync these manually. |
| **"AMBIGUOUS match" for some items** | You have multiple listings with very similar titles (e.g. size variants). Add SKUs to your Crosslist listings — the extension uses them to tell similar items apart. |
| **Extension not appearing in toolbar** | Go to `chrome://extensions` and make sure it's enabled (toggle is on). Then click the puzzle piece icon in Chrome and pin it. |
| **Extension stopped working after moving the folder** | Chrome loads the extension from the folder's original location. Go to `chrome://extensions`, remove the extension, and re-load it from the new location. |
| **Sync seems stuck** | The Crosslist tab may have a dialog or notification blocking the automation. Switch to the Crosslist tab, close any popups or dialogs, and the sync should continue. |
| **Items getting processed twice** | Synced items are tracked in the History for 30 days. After that, history entries expire so returned/relisted items can be re-synced. If items are being duplicated within 30 days, check the History tab. |

---

## Privacy

CrosslistPlus runs entirely in your browser. It does not:
- Send your data to any external server
- Store your passwords
- Track your usage
- Communicate with anything other than Vinted, eBay, and Crosslist (using your existing browser sessions)

All data (sync history, settings, progress) is stored locally in Chrome's extension storage on your computer.

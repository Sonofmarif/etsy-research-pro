# Etsy Research Pro — Production Update & Maintenance Guide

This guide explains how to make updates and live changes to both the **Chrome Extension** and the **Cloudflare Worker Backend** once they are in production.

---

## Part 1: Updating the Cloudflare Worker Backend (Instant Live Update)

Since the backend runs on Cloudflare's serverless edge, updates to the API are **instant** and **do not require users to update their Chrome Extensions**.

### 1. Modifying the API Code (`worker.js`)
If you want to add a new endpoint, modify the JSON response format, or optimize database queries:
1. Edit the `worker.js` file inside the `cloudflare-worker` directory.
2. In your terminal, run:
   ```bash
   wrangler deploy
   ```
3. Cloudflare will upload the code and deploy it globally. The changes are live **instantly** (within 5 seconds) for all users.

### 2. Updating the Database Schema (`schema.sql`)
If you want to add a new column or table to your live SQL database:
1. Run a direct query on your remote D1 database:
   ```bash
   wrangler d1 execute etsy-research-pro-db --remote --command="ALTER TABLE research_runs ADD COLUMN new_metric INTEGER DEFAULT 0;"
   ```
2. Alternatively, modify your `schema.sql` file and execute the script remotely (be careful not to overwrite existing data).

---

## Part 2: Updating the Chrome Extension (Frontend)

To push changes (UI designs, scraper selectors, bug fixes) to your users, you need to update the extension code.

### 1. Preparing the Code for Release
1. Make your edits in `manifest.json`, `src/`, etc.
2. Open **[manifest.json](file:///C:/Users/HP/Downloads/Etsy%20Research%20tool/etsy-research-pro/manifest.json)**.
3. Increment the `"version"` number:
   ```json
   "version": "1.0.1", // Change from 1.0.0
   ```
   *Always increment this version, otherwise the Chrome Web Store or local browsers will not recognize the update.*

### 2. Testing Locally
Before zipping, make sure your changes work:
1. Open Chrome and navigate to `chrome://extensions`.
2. Click the **Reload** (circular arrow) icon on the **Etsy Research Pro** card.
3. Verify your changes in the popup and dashboard.

### 3. Zipping the Extension
To distribute the extension, you must compress the folder into a `.zip` archive:
1. Zip **only** the `etsy-research-pro` folder.
2. **Exclude** the `cloudflare-worker/` folder and `niche-moat-extension-ref/` folder from the ZIP to keep the size small.
3. Name it something like `etsy-research-pro-v1.0.1.zip`.

### 4. Uploading to Chrome Web Store (If Publicly Listed)
If you publish the extension on the developer dashboard:
1. Go to the [Chrome Web Store Developer Console](https://developer.chrome.com/publish).
2. Click on your extension item.
3. Go to **Package** → **Upload New Package** and select your new `.zip` file.
4. Fill in any description updates and click **Submit for Review**.
5. Once approved by Google (usually 1-3 days), users' browsers will **automatically update** the extension in the background within 24-48 hours.

### 5. Manual Distribution (If Sharing ZIP Directly)
If your users install the unpacked extension manually (e.g. team members or VIP sellers):
1. Send them the new `etsy-research-pro-v1.0.1.zip` file.
2. Tell them to extract it and replace the files inside their existing local extension directory.
3. Go to `chrome://extensions` and click **Reload**.

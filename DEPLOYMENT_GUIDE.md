# Etsy Research Pro — Cloudflare Worker & D1 Database Deployment Guide

This guide describes how to deploy the **Etsy Research Pro** backend to Cloudflare's free tier. 
Cloudflare D1 is a serverless SQL database that allows **5 million reads/day and 100,000 writes/day** for free, making it perfect for supporting 1,000 to 5,000 active users without cost.

---

## Prerequisites
1. **Node.js** (v18 or higher) installed on your computer.
2. A free **Cloudflare Account** (sign up at [dash.cloudflare.com](https://dash.cloudflare.com)).

---

## Step 1: Install Wrangler CLI
Wrangler is Cloudflare's command-line tool. Open your terminal (PowerShell, Command Prompt, or terminal) and navigate to the `cloudflare-worker` directory:

```bash
cd "C:\Users\HP\Downloads\Etsy Research tool\etsy-research-pro\cloudflare-worker"
```

Install the Wrangler CLI globally (if you haven't already):
```bash
npm install -g wrangler
```

---

## Step 2: Log In to Cloudflare
Authenticate Wrangler with your Cloudflare account:
```bash
wrangler login
```
This will open a browser window asking you to authorize Wrangler. Click **Allow**.

---

## Step 3: Create the D1 SQL Database
Run the following command to create a new D1 database instance:
```bash
wrangler d1 create etsy-research-pro-db
```

This will output details about the created database, including a **Database ID** (UUID). It will look something like this:
```text
✅ Successfully created database 'etsy-research-pro-db'
Copy the following lines to your wrangler.toml:

[[d1_databases]]
binding = "DB"
database_name = "etsy-research-pro-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

---

## Step 3b: Create the KV Cache Namespace
Run the following command to create a new Workers KV namespace for caching results:
```bash
wrangler kv namespace create etsy_research_cache
```

This will output details about the created KV namespace, including an **ID**. It will look something like this:
```text
✅ Successfully created KV namespace 'etsy_research_cache'
Copy the following lines to your wrangler.toml:

[[kv_namespaces]]
binding = "KV"
id = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
```

---

## Step 4: Configure `wrangler.toml`
Open `wrangler.toml` in your project folder and replace the placeholders for the D1 database ID and KV namespace ID with the actual IDs outputted in the previous steps:

```toml
[[d1_databases]]
binding = "DB"
database_name = "etsy-research-pro-db"
database_id = "YOUR_ACTUAL_DATABASE_ID_FROM_STEP_3"

[[kv_namespaces]]
binding = "KV"
id = "YOUR_ACTUAL_KV_NAMESPACE_ID_FROM_STEP_3B"
```

---

## Step 5: Initialize the Database Schema
Execute the SQL schema to create the required tables in your D1 database:

### Local Development / Testing:
```bash
wrangler d1 execute etsy-research-pro-db --local --file=schema.sql
```

### Production (Cloudflare Cloud):
```bash
wrangler d1 execute etsy-research-pro-db --remote --file=schema.sql
```

---

## Step 6: Seed Default Keywords (Optional but Recommended)
To populate the database with initial keywords so new users see seeds immediately, run:
```bash
wrangler d1 execute etsy-research-pro-db --remote --command="INSERT INTO seed_keywords (category, keyword, priority) VALUES ('Islamic/Spiritual', 'crystal prayer beads 99', 10), ('Islamic/Spiritual', 'ramadan planner pdf', 9), ('Home Decor', 'minimalist wall art set', 10), ('Digital Planners', 'notion template aesthetic', 10);"
```
*(You can add more keywords as needed using similar INSERT statements).*

---

## Step 7: Deploy the Worker
Deploy the API endpoints to Cloudflare:
```bash
wrangler deploy
```

Once the deployment finishes, wrangler will print your live **Worker URL**. It will look like:
`https://etsy-research-pro.your-subdomain.workers.dev`

---

## Step 8: Connect the Chrome Extension to Your Live Backend
1. Open the [etsy-research-pro/src/utils/config.js](file:///C:/Users/HP/Downloads/Etsy%20Research%20tool/etsy-research-pro/src/utils/config.js) file.
2. Edit line 32 (`worker_url`) to point to your live Worker URL:
   ```javascript
   worker_url: 'https://etsy-research-pro.your-subdomain.workers.dev',
   ```
3. Load the unpacked extension again in `chrome://extensions` (click the **Reload** circular arrow icon on the extension card).
4. Go to **Settings** in the extension popup and toggle **"Share anonymous data for community insights"** on.

---

## 🛠️ Testing the Setup
* **Health Check**: Visit `https://etsy-research-pro.your-subdomain.workers.dev/health` in your browser. It should return `{"status":"ok","version":"1.0.0"}`.
* **Seeds Endpoint**: Visit `https://etsy-research-pro.your-subdomain.workers.dev/seeds`. It should return a list of categories.

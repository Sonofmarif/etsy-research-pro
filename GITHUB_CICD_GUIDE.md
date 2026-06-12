# Etsy Research Pro — GitHub CI/CD Automation Guide

This guide explains how to set up **Continuous Deployment (CD)** so that whenever you push changes to GitHub, your Cloudflare Worker backend is automatically updated live.

---

## Step 1: Initialize Git and Push to GitHub
If you haven't linked your local project folder to GitHub yet, run these commands in your project's root directory (`C:\Users\HP\Downloads\Etsy Research tool`):

1. **Initialize Git Repository**:
   ```bash
   git init
   ```
2. **Add Files**:
   ```bash
   git add .
   ```
3. **Commit Code**:
   ```bash
   git commit -m "Initial commit for Etsy Research Pro"
   ```
4. **Create Repository on GitHub**:
   Go to [github.com/new](https://github.com/new) and create a repository named `etsy-research-pro`. (Do **not** initialize it with a README, license, or gitignore).
5. **Link and Push**:
   ```bash
   git remote add origin https://github.com/YOUR_GITHUB_USERNAME/etsy-research-pro.git
   git branch -M main
   git push -u origin main
   ```

---

## Step 2: Get Cloudflare Credentials

To allow GitHub to deploy to your Cloudflare account, you need an **API Token** and your **Account ID**:

### 1. Generate Cloudflare API Token:
1. Go to your [Cloudflare Dashboard Profile page](https://dash.cloudflare.com/profile/api-tokens).
2. Click **Create Token**.
3. Under Templates, find **Edit Cloudflare Workers** and click **Use template**.
4. Scroll to the bottom and click **Continue to summary**.
5. Click **Create Token**.
6. **Copy the API Token** immediately (it will only show once).

### 2. Find Your Cloudflare Account ID:
1. Go to the Cloudflare dashboard homepage or [Workers & Pages dashboard](https://dash.cloudflare.com/page-id/workers-and-pages).
2. Look at the right sidebar. Under **Account ID**, copy the long alphanumeric string.

---

## Step 3: Add Secrets to GitHub

Add these credentials securely to your GitHub repository:

1. Open your repository on GitHub.
2. Go to **Settings** (tab at the top) → **Secrets and variables** (left menu) → **Actions**.
3. Click **New repository secret** (green button).
4. Add the first secret:
   * **Name**: `CLOUDFLARE_API_TOKEN`
   * **Secret**: (Paste the API token you copied in Step 2.1)
5. Click **Add secret**.
6. Click **New repository secret** again and add the second secret:
   * **Name**: `CLOUDFLARE_ACCOUNT_ID`
   * **Secret**: (Paste the Account ID you copied in Step 2.2)
7. Click **Add secret**.

---

## Step 4: Test the Live Automation!

Any future commit that updates files under `etsy-research-pro/cloudflare-worker/` will trigger a deployment automatically:

1. Make a small edit in `etsy-research-pro/cloudflare-worker/worker.js` (e.g. update a log message).
2. Commit and push:
   ```bash
   git add etsy-research-pro/cloudflare-worker/worker.js
   git commit -m "Update backend API logs"
   git push origin main
   ```
3. Go to the **Actions** tab of your GitHub repository.
4. You will see a running workflow named **"Deploy Cloudflare Worker"**. When it completes (usually ~45 seconds), your API is live on Cloudflare!

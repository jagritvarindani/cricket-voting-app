# Cricket Voting App — Render Deployment

## Deploy to Render (Free, No Credit Card Required)

### Option 1: Deploy via GitHub (Recommended)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) and sign up free
3. Click **New → Web Service**
4. Connect your GitHub repo
5. Render will auto-detect `render.yaml` and configure everything
6. Click **Create Web Service**

That's it! The persistent disk is configured automatically via `render.yaml`.

### Option 2: Manual Setup on Render Dashboard

1. Go to render.com → **New → Web Service**
2. Connect your repo
3. Settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Add **Disk**: click "Add Disk"
   - Name: `cricket-data`
   - Mount Path: `/data`
   - Size: 1 GB
5. Add **Environment Variable**:
   - `DATA_DIR` = `/data`
6. Click **Create Web Service**

## Data Persistence

- Vote data is stored in `/data/votersPool.json`
- Match results stored in `/data/matchResults.json`
- On first boot, data is seeded from `data-defaults/`
- Data persists across restarts and redeploys ✓

## Admin Emails
- jeetandra@gmail.com
- jagrit@gmail.com

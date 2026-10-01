# WatchDNA Store Locator - Capstone Project

Welcome to the Capstone Project Repo! This project includes:
- **Python tools** for CSV validation and web scraping
- **Admin Panel** (Backend + Frontend) for managing store locations
- **Store Locator** integration system
- **User Frontend** Map + Store Locator for WatchDNA users

## Project Structure

```
WatchDNA-Store-Locator-Captstone/
├── backend/              # Admin panel API (Node.js + Express + Prisma)
├── admin-frontend/       # Admin panel UI (React + TypeScript + Vite)
├── tools/                # Python validation & scraping scripts
├── user-frontend         # Map Frontend UI (HTML + CSS + Leaflet JS + OSM)
└── venv/                 # Python virtual environment
```

---

## Quick Start - Admin Panel

The admin panel allows you to upload, validate, and manage store location CSV files.

### Prerequisites

- **Node.js 18+** and npm
- **Python 3.x** (for CSV validation scripts)

### 1. Backend Setup

```bash
cd backend
npm install
cp .env.example .env
npx prisma migrate deploy
npm run seed-admin
npm run dev
```

This is the first step to opening the admin panel. The Map Frontend will also start on `http://localhost:3001`, with the initialization of the backend. 

### 2. Admin Panel Setup

```bash
cd admin-frontend
npm install
npm run dev
```

With step 1 and step 2, the Admin Panel frontend will start on `http://localhost:5173`

**Default admin credentials:**
- Username: `admin`
- Password: `admin123`

Quick pointers:
- Start backend & map frontend: `cd backend && npm install && npm run dev`
- Start admin panel frontend: `cd admin-frontend && npm install && npm run dev`

For development details, run the commands in the relevant folder and consult that folder's README.
   # or: brew install direnv       # Mac

Note: the map-frontend is deployed on Vercel under the URL ```https://dealer-fetcher.vercel.app```. The admin-panel frontend is live on ```https://admin-console-production.up.railway.app/login```.

The map is live on the shopify site as an iframe, and the backend (Admin Panel and Scraper) is live on shopify as an app. 

# Admin Frontend — WatchDNA Admin UI

Folder-local instructions for the React admin panel.

Quick setup:

```powershell
cd admin-frontend
npm install
npm run dev
```

Default dev URL: http://localhost:5173

Key locations in this folder:

- `src/pages/` — Page components (Login, Dashboard, Uploads, UploadDetail, Scraper)
- `src/components/` — Reusable UI components (Layout, ProtectedRoute)
- `src/services/api.ts` — Axios instance and interceptors

Available scripts:

- `npm run dev` — Start dev server
- `npm run build` — Build production assets
- `npm run preview` — Preview production build
- `npm run lint` — Run ESLint

Notes:
- The frontend expects the backend API to provide authentication and upload endpoints. See `../backend/README.md` for backend setup.
- Default admin credentials (dev seed): username `admin`, password `admin123`.

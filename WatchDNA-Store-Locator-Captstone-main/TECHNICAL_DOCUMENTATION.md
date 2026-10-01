# WatchDNA Store Locator - Technical Documentation

**Project:** WatchDNA Store Locator Capstone
**Version:** 1.0.0
**Last Updated:** February 19, 2026
**Status:** Active Development

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [System Architecture](#system-architecture)
3. [Technology Stack](#technology-stack)
4. [File Structure & Navigation](#file-structure--navigation)
5. [Installation & Setup](#installation--setup)
6. [Hosting & Deployment](#hosting--deployment)
7. [Libraries & Dependencies](#libraries--dependencies)
8. [APIs & SDKs](#apis--sdks)
9. [License Information](#license-information)
10. [Database Schema](#database-schema)
11. [API Endpoints](#api-endpoints)
12. [Additional Resources](#additional-resources)

## Project Overview

The WatchDNA Store Locator is a comprehensive web application designed to manage, validate, and display watch retailer locations across multiple geographic regions. The system consists of three main components:

1. 3. **Interactive Map** - Store locator front-end with premium vendor classification
2. **Admin Panel** - Full-stack web application for managing store locations
3. **Python Tools** - CSV validation and web scraping utilities

### Key Features

- CSV file upload and validation
- Automated web scraping for store data
- Interactive map visualization with Leaflet.js
- Premium vendor detection and classification
- Multi-language support (English, French, Chinese, Spanish)
- Geographic search and filtering
- RESTful API for location management
- JWT-based authentication system

## System Architecture

The system is composed of three primary logical layers: the Admin frontend (React + Vite), the Backend API (Node.js/Express + TypeScript + Prisma), and supporting Python tools used for scraping and validation. Supporting services include a relational database (PostgreSQL in production, SQLite locally), CDN-hosted map libraries, and external APIs for geocoding and analytics.

Hosting (current):
- **user-frontend** (public map prototype) is deployed on **Vercel**. The static `index.html` served by this site fetches location data via the public API endpoints.
- **admin-frontend** (admin panel) and **backend API** are deployed on **Railway**. The backend hosts the PostgreSQL database instance on Railway.

Behavioral note: the `user-frontend` on Vercel requests data from the backend API running on Railway; the backend queries the PostgreSQL database (Railway) and returns JSON to the frontend. Ensure CORS and environment variables (API base URL, DB connection string for backend) are configured for each environment.

### Architecture Diagram

This section maps repository components to their runtime hosts and key entrypoints — useful for operators and deploy scripts. 

                        ┌─────────────────┐
                        │   User browser  │
                        └────────┬────────┘
                   visit map /       \ admin UI
                            /         \
          ┌────────────────▼┐   ┌──────▼──────────────┐
          │  user-frontend  │   │   admin-frontend    │
          │  index.html     │   │   src/main.tsx      │
          │  Vercel         │   │   Railway           │
          └────────┬────────┘   └──────────┬──────────┘
           map libs|        \              | API requests
                   |         \API requests |
          ┌────────▼───────┐  \ ┌──────────▼─────────┐
          │ Leaflet /      │    │     Backend API    │
          │ MarkerCluster  │    │  backend/server.ts │
          │ CDN            │    │  Railway           │
          └────────────────┘    └──┬─────┬──────┬────┘
                                   |     |      |
                    reads/writes   |     |      |  invokes
                 ┌─────────────────┘     |      └──────────────────┐
                 |               stores  |                         |
                 |               files   |                         |
          ┌──────▼──────┐   ┌────────────▼──┐            ┌─────────▼────────┐
          │ PostgreSQL  │   │   uploads/    │            │   Python tools   │
          │ Railway     │   │ file storage  │            │ tools/           │
          └──────┬──────┘   └─────────────┬─┘            │ Prototypes/      │
                 |                        |              │ Data_Scrappers/  │
       geocoding |              analytics |              └──────────────────┘
                 |                        |
          ┌──────▼──────────────┐    ┌────▼─────────────────┐
          │  Geocoding API      │    │ Analytics/Monitoring │
          │  External service   │    │ External service     │
          └─────────────────────┘    └──────────────────────┘


See `repo_runtime_architecture.svg` for a better visual. 

| Component | Runtime Host | Repo Path | Entrypoint |
|-----------|--------------|-----------|------------|
| User map (public) | Vercel | `user-frontend/` | `user-frontend/index.html` |
| Admin panel | Railway | `admin-frontend/` | `admin-frontend/src/main.tsx` |
| Backend API | Railway | `backend/` | `backend/src/server.ts` |
| Database (Postgres) | Railway Postgres | `backend/prisma/schema.prisma` | `DATABASE_URL` (Railway env) |
| File uploads / store images | Railway storage (backend app) | `uploads/` | backend file handlers (`backend/src/controllers/upload.controller.ts`) |
| Python tools / scrapers | Local / Railway job | `tools/`, `Prototypes/Data_Scrappers/` | `tools/validate_csv.py`, `Prototypes/Data_Scrappers/universal_scraper.py` |

Notes:
- The frontend (Vercel) must call the backend API (Railway) — do not expose DB credentials to the frontend.
- Keep the `API_BASE_URL` (or equivalent) env var set in Vercel and Railway for each deployment.

## Technology Stack

### Backend Technologies

|      Technology       | Version |               Purpose                |
|-----------------------|---------|--------------------------------------|
| **Node.js**           | 18+     | JavaScript runtime environment       |
| **Express.js**        | 4.18.2  | Web application framework            |
| **TypeScript**        | 5.3.3   | Type-safe JavaScript                 |
| **Prisma**            | 5.22.0  | ORM and database toolkit             |
| **PostgreSQL**        | Latest  | Production database (SQLite for dev) |

### Admin-Panel Frontend Technologies

|       Technology      | Version |                Purpose               |
|-----------------------|---------|--------------------------------------|
| **React**             | 19.1.1  | UI component library                 |
| **TypeScript**        | 5.9.3   | Type-safe JavaScript                 |
| **Vite**              | 6.4.1   | Build tool and dev server            |
| **React Router**      | 6.30.1  | Client-side routing                  |
| **Axios**             | 1.12.2  | HTTP client                          |

### Python Tools

|       Technology      | Version |                Purpose               |
|-----------------------|---------|--------------------------------------|
| **Python**            | 3.x     | Scripting language                   |
| **beautifulsoup4**    | 4.14.2  | HTML parsing                         |
| **requests**          | 2.32.5  | HTTP library                         |
| **lxml**              | 6.0.2   | XML/HTML parser                      |
| **typing_extensions** | 4.15.0  | Type hints backport                  |

### Map Visualization

|     Technology        | Version |                Purpose               |
|-----------------------|---------|--------------------------------------|
| **Leaflet.js**        | 1.9.4   | Interactive maps                     |
| **MarkerCluster**     | 1.5.3   | Marker clustering                    |
| **PapaParse**         | 5.5.3   | CSV parsing                          |


## File Structure & Navigation

```
WatchDNA-Store-Locator-Captstone/
├── Dockerfile                                        # container definition for deployment
├── README.md                                         # Main documentation
├── TECHNICAL_DOCUMENTATION.md                        # This file
├── railway.toml
├── requirements.txt                                  # Python dependencies
├── Prototypes/                                       # Web scraping tools (universal scraper, normalization, pattern detection, geocoding, viewport simulation)
│   ├── Data_Scrappers/  
│   │   ├── brand_configs.json                        # Brand configurations
│   │   ├── dev_tools/                                # Development and testing utilities
│   │   └── test_output/                              # Scraper test output CSVs
│   └── endpoint_discoverer/                          # tools to discover and verifying brand store locator API endpoints
├── admin-frontend/                                   # Admin Panel UI
│   ├── README.md                                     # Frontend docs
│   ├── package.json                                  # Dependencies
│   ├── tsconfig.json                                 # TypeScript config
│   ├── vite.config.ts                                # Vite configuration
│   ├── shopify.app.toml                              # Shopify embedded app configuration
│   └── src/
│       ├── App.tsx                                   # Root component
│       ├── main.tsx                                  # React entry point
│       ├── components/                               # React components (layout, auth guard, modals)
│       ├── contexts/                                 # React context (auth state)
│       ├── pages/                                    # Page components (dashboard, uploads, scraper, analytics, premium)
│       ├── services/                                 # API clients (axios, scraper, analytics, premium)
│       ├── styles/                                   # CSS files
│       └── types/                                    # Shared TypeScript types
├── assets/
│   └── markers/                                      # Map pin images
│       └── watchdna_clear_pin.png                    # Old watchdna pin
├── backend/                                          # Backend Database
│   ├── .env.example                                  # Environment template
│   ├── README.md                                     # Backend docs
│   ├── brand_configs.json                            # Brand configurations
│   ├── package.json                                  # Dependencies
│   ├── tsconfig.json                                 # TypeScript config
│   ├── vitest.config.ts                              # Vitest test runner configuration
│   ├── prisma/                                       # Database schema and migrations
│   ├── uploads/                                      # Uploaded/scraped CSVs (master data lives in DB; export when needed)
│   └── src/
│       ├── server.ts                                 # Express application entry
│       ├── load-env.ts                               #  Loads and validates environment variables before startup
│       ├── config/                                   # App configuration (geocoding, validation policy)
│       ├── controllers/                              # Request handlers (auth, locations, uploads, scraper, analytics, premium)
│       ├── data/                                     # Static reference data
│       ├── lib/                                      # Shared library instances (Prisma client)
│       ├── middleware/                               # Express middleware (auth, rate limiting, security, uploads)
│       ├── routes/                                   # API route definitions (auth, locations, uploads, scraper, analytics, health, premium)
│       ├── scripts/                                  # CLI utility scripts (import, reset, normalize, verify, audit)
│       ├── services/                                 # Business logic (auth, locations, uploads, scraper, geocoding, analytics, premium)
│       ├── tests/                                    # Unit and integration tests
│       └── utils/                                    # Shared utilities (geocoding, deduplication, normalization, filtering, merging)
├── tools/                                            # Python utilities
│   ├── add_test_row.py                               # Test data generator
│   ├── brand_sweep_state.json                        # Tracks scraper progress across brand sweep runs
│   ├── translate_stores.py                           # # Translates non-English store data to English
│   └── validate_csv.py                               # CSV validation
└── user-frontend/                                    # Map prototype (Express serves prototype.html at /)
    ├── index.html                                    # Current map deployed on Vercel
    ├── prototype.html                                # Oudated prototype of map
    ├── styles.css                                    # Styles for map
    ├── vercel.json                                   # Connects Railway and Vercel
    └── imgs/                                         # CURRENT Map pin and marker images
```

### Key Directories Explained

- **[backend/src/controllers/](backend/src/controllers/)** - HTTP request handlers (auth, locations, uploads, scraper, analytics, premium)
- **[backend/src/services/](backend/src/services/)** - Business logic layer (auth, locations, uploads, scraper, geocoding, analytics, premium)
- **[backend/src/routes/](backend/src/routes/)** - API endpoint definitions (auth, locations, uploads, scraper, analytics, health, premium)
- **[backend/src/middleware/](backend/src/middleware/)** - Express middleware (auth, rate limiting, security, uploads)
- **[backend/src/utils/](backend/src/utils/)** - Shared utilities (geocoding, deduplication, normalization, filtering, merging)
- **[backend/src/scripts/](backend/src/scripts/)** - CLI utility scripts (import, reset, normalize, verify, audit)
- **[backend/src/config/](backend/src/config/)** - App configuration (geocoding, validation policy)
- **[backend/prisma/](backend/prisma/)** - Database schema and migrations


- **[admin-frontend/src/pages/](admin-frontend/src/pages/)** - Page components (dashboard, uploads, scraper, analytics, premium)
- **[admin-frontend/src/components/](admin-frontend/src/components/)** - Reusable React components (layout, auth guard, modals)
- **[admin-frontend/src/services/](admin-frontend/src/services/)** - API clients (axios, scraper, analytics, premium)


- **[user-frontend/](user-frontend/)** - Public-facing map UI (store locator prototype served via Express)
- **[user-frontend/imgs/](user-frontend/imgs/)** - Map pin and marker images
- **[tools/](tools/)** - Python validation and utility scripts


- **[Prototypes/Data_Scrappers/](Prototypes/Data_Scrappers/)** - Web scraping tools (universal scraper, normalization, pattern detection, geocoding, viewport simulation)
- **[Prototypes/endpoint_discoverer/](Prototypes/endpoint_discoverer/)** - Tools for discovering and verifying brand store locator API endpoints

---

## Installation & Setup



### Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.x
- **PostgreSQL** (for production) or SQLite (for development)
- **Git** for version control

### 1. Clone Repository

```bash
git clone https://github.com/swansluk03/WatchDNA-Store-Locator-Captstone
cd WatchDNA-Store-Locator-Captstone
```

### 2. Backend Setup

```bash
cd backend

# Install Node dependencies
npm install

# Create environment file
cp .env.example .env

# Generate Prisma client
npx prisma generate

# Run database migrations
npx prisma migrate deploy

# Seed admin user (username: admin, password: admin123)
npm run seed-admin

# Start development server
npm run dev
```

### 3. Frontend Setup

USER Frontend:

Frontend (`index.html`) will run on `http://localhost:3001`. The `user-frontend` is a static site that fetches data from the backend. No separate install is needed. Ensure the backend is running before opening this link in your local browser. 

ADMIN Fronted:

In a new terminal:

```bash
cd admin-frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

Frontend will run on `http://localhost:5173`

### 4. Python Tools Setup

 
**Mac/Linux:**
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```
 
**Windows:**
```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```
 
Run a tool:
```bash
python tools/validate_csv.py path/to/your.csv
```

## Hosting & Deployment

- **Vercel (user-frontend):** The `user-frontend/` static site (public map) is deployed to Vercel. The public map's `index.html` fetches data via the production API endpoints.

- **Railway (admin-frontend + backend + DB):** The `admin-frontend/` and `backend/` projects are deployed on Railway. Railway also runs the production PostgreSQL instance used by the backend. Railway environment variables include for `DATABASE_URL`, `JWT_SECRET`, `UPLOAD_DIR`, and any other secrets. Use Railway's automatic deployments from `main`. 

Operational notes:
- The `user-frontend` served by Vercel requests JSON from the backend API hosted on Railway; the backend makes queries against the Railway PostgreSQL instance and returns results. Do not expose the database directly to the browser — keep `DATABASE_URL` and DB credentials in Railway environment variables, accessible only to the backend.
- CORS is configured on the backend to allow the Vercel origin (see `vercel.json`).
- Railway database backups/retention is set up, a secure secrets store for production credentials is configured.

---

## Libraries & Dependencies
 
### Backend Dependencies
 
#### Production Dependencies
 
| Library | Version | License | Source | Purpose |
|---------|---------|---------|--------|---------|
| **@prisma/client** | 5.22.0 | Apache-2.0 | [npm](https://www.npmjs.com/package/@prisma/client) | Database ORM client |
| **@types/bcrypt** | 5.0.0 | MIT | [npm](https://www.npmjs.com/package/@types/bcrypt) | TypeScript definitions (bcrypt) |
| **@types/jsonwebtoken** | 9.0.10 | MIT | [npm](https://www.npmjs.com/package/@types/jsonwebtoken) | TypeScript definitions (jsonwebtoken) |
| **bcrypt** | 6.0.0 | MIT | [npm](https://www.npmjs.com/package/bcrypt) | Password hashing |
| **cors** | 2.8.5 | MIT | [npm](https://www.npmjs.com/package/cors) | Cross-origin resource sharing |
| **dotenv** | 16.3.1 | BSD-2-Clause | [npm](https://www.npmjs.com/package/dotenv) | Environment variables |
| **express** | 4.18.2 | MIT | [npm](https://www.npmjs.com/package/express) | Web framework |
| **express-rate-limit** | 8.2.1 | MIT | [npm](https://www.npmjs.com/package/express-rate-limit) | API rate limiting |
| **i18n-iso-countries** | 7.14.0 | MIT | [npm](https://www.npmjs.com/package/i18n-iso-countries) | ISO country code lookups |
| **jsonwebtoken** | 9.0.2 | MIT | [npm](https://www.npmjs.com/package/jsonwebtoken) | JWT authentication |
| **libphonenumber-js** | 1.12.41 | MIT | [npm](https://www.npmjs.com/package/libphonenumber-js) | Phone number parsing/validation |
| **multer** | 1.4.5-lts.1 | MIT | [npm](https://www.npmjs.com/package/multer) | File upload handling |
| **papaparse** | 5.5.3 | MIT | [npm](https://www.npmjs.com/package/papaparse) | CSV parsing |
| **uuid** | 9.0.1 | MIT | [npm](https://www.npmjs.com/package/uuid) | UUID generation |
 
#### Development Dependencies
 
| Library | Version | License | Source | Purpose |
|---------|---------|---------|--------|---------|
| **prisma** | 5.22.0 | Apache-2.0 | [npm](https://www.npmjs.com/package/prisma) | Database toolkit & migrations |
| **supertest** | 7.2.2 | MIT | [npm](https://www.npmjs.com/package/supertest) | HTTP integration testing |
| **ts-node** | 10.9.2 | MIT | [npm](https://www.npmjs.com/package/ts-node) | TypeScript execution |
| **ts-node-dev** | 2.0.0 | MIT | [npm](https://www.npmjs.com/package/ts-node-dev) | Dev server with hot reload |
| **typescript** | 5.3.3 | Apache-2.0 | [npm](https://www.npmjs.com/package/typescript) | TypeScript compiler |
| **vitest** | 4.1.2 | MIT | [npm](https://www.npmjs.com/package/vitest) | Unit test runner |
| **@types/cors** | 2.8.17 | MIT | [npm](https://www.npmjs.com/package/@types/cors) | TypeScript definitions |
| **@types/express** | 4.17.21 | MIT | [npm](https://www.npmjs.com/package/@types/express) | TypeScript definitions |
| **@types/multer** | 1.4.11 | MIT | [npm](https://www.npmjs.com/package/@types/multer) | TypeScript definitions |
| **@types/node** | 20.10.5 | MIT | [npm](https://www.npmjs.com/package/@types/node) | TypeScript definitions |
| **@types/papaparse** | 5.5.0 | MIT | [npm](https://www.npmjs.com/package/@types/papaparse) | TypeScript definitions |
| **@types/supertest** | 7.2.0 | MIT | [npm](https://www.npmjs.com/package/@types/supertest) | TypeScript definitions |
| **@types/uuid** | 9.0.7 | MIT | [npm](https://www.npmjs.com/package/@types/uuid) | TypeScript definitions |
 
Reference: `backend/package.json`
 
---
 
### Admin Frontend Dependencies
 
#### Production Dependencies
 
| Library | Version | License | Source | Purpose |
|---------|---------|---------|--------|---------|
| **axios** | 1.12.2 | MIT | [npm](https://www.npmjs.com/package/axios) | HTTP client |
| **react** | 19.1.1 | MIT | [npm](https://www.npmjs.com/package/react) | UI library |
| **react-dom** | 19.1.1 | MIT | [npm](https://www.npmjs.com/package/react-dom) | React DOM rendering |
| **react-router-dom** | 6.30.1 | MIT | [npm](https://www.npmjs.com/package/react-router-dom) | Client-side routing |
| **serve** | 14.2.6 | MIT | [npm](https://www.npmjs.com/package/serve) | Static file server for production |
 
#### Development Dependencies
 
| Library | Version | License | Source | Purpose |
|---------|---------|---------|--------|---------|
| **vite** | 6.4.1 | MIT | [npm](https://www.npmjs.com/package/vite) | Build tool and dev server |
| **@vitejs/plugin-react** | 4.3.4 | MIT | [npm](https://www.npmjs.com/package/@vitejs/plugin-react) | React plugin for Vite |
| **typescript** | ~5.9.3 | Apache-2.0 | [npm](https://www.npmjs.com/package/typescript) | TypeScript compiler |
| **typescript-eslint** | 8.45.0 | MIT | [npm](https://www.npmjs.com/package/typescript-eslint) | TypeScript ESLint integration |
| **eslint** | 9.36.0 | MIT | [npm](https://www.npmjs.com/package/eslint) | Code linting |
| **@eslint/js** | 9.36.0 | MIT | [npm](https://www.npmjs.com/package/@eslint/js) | ESLint JavaScript config |
| **eslint-plugin-react-hooks** | 5.2.0 | MIT | [npm](https://www.npmjs.com/package/eslint-plugin-react-hooks) | React Hooks linting |
| **eslint-plugin-react-refresh** | 0.4.22 | MIT | [npm](https://www.npmjs.com/package/eslint-plugin-react-refresh) | React Refresh linting |
| **@types/node** | 24.6.0 | MIT | [npm](https://www.npmjs.com/package/@types/node) | TypeScript definitions |
| **@types/react** | 19.1.16 | MIT | [npm](https://www.npmjs.com/package/@types/react) | TypeScript definitions |
| **@types/react-dom** | 19.1.9 | MIT | [npm](https://www.npmjs.com/package/@types/react-dom) | TypeScript definitions |
| **globals** | 16.4.0 | MIT | [npm](https://www.npmjs.com/package/globals) | Global identifiers for ESLint |
 
Reference: `admin-frontend/package.json`
 
---
 
### Python Dependencies
 
The following packages are directly imported by files in `tools/` and `Prototypes/`. The full pinned environment is in `requirements.txt` — that file is the authoritative source for reproducible installs and includes additional packages from the broader development environment not listed here.
 
| Library | Version | License | Source | Purpose |
|---------|---------|---------|--------|---------|
| **beautifulsoup4** | 4.14.2 | MIT | [PyPI](https://pypi.org/project/beautifulsoup4/) | HTML parsing (`bs4`) |
| **deep-translator** | — | MIT | [PyPI](https://pypi.org/project/deep-translator/) | Store data translation |
| **httpx** | 0.28.1 | BSD | [PyPI](https://pypi.org/project/httpx/) | Async HTTP client |
| **lxml** | 6.0.2 | BSD | [PyPI](https://pypi.org/project/lxml/) | XML/HTML parser |
| **psycopg2** | 2.9.11 | LGPL | [PyPI](https://pypi.org/project/psycopg2/) | PostgreSQL adapter |
| **pytest** | — | MIT | [PyPI](https://pypi.org/project/pytest/) | Test runner |
| **requests** | 2.32.5 | Apache-2.0 | [PyPI](https://pypi.org/project/requests/) | HTTP requests |
| **selenium** | 4.15.2 | Apache-2.0 | [PyPI](https://pypi.org/project/selenium/) | Headless browser scraping |
| **typing_extensions** | 4.15.0 | PSF | [PyPI](https://pypi.org/project/typing-extensions/) | Type hints backport |
| **webdriver-manager** | — | Apache-2.0 | [PyPI](https://pypi.org/project/webdriver-manager/) | Auto-manages ChromeDriver |
 
Standard library modules also used: `argparse`, `csv`, `json`, `os`, `re`, `sys`, `math`, `time`, `html`, `pathlib`, `urllib.parse`, `concurrent.futures`, `collections`, `tempfile`, `importlib`.
 
**Notes:**
- `deep-translator`, `pytest`, and `webdriver-manager` are not pinned in `requirements.txt` — verify they are present in your environment or add them explicitly.
- Use `pip install -r requirements.txt` to install the full environment. The file contains many packages beyond those listed here from the broader dev environment.
- For `psycopg2` on non-Linux platforms, prefer `psycopg2-binary` to avoid native build issues, or run inside Docker.
---
 
### CDN / Front-End Map Libraries
 
| Library | Version | License | Source | Purpose |
|---------|---------|---------|--------|---------|
| **Leaflet.js** | 1.9.4 | BSD-2-Clause | [unpkg](https://unpkg.com/leaflet@1.9.4/) | Interactive maps |
| **Leaflet.markercluster** | 1.5.3 | MIT | [unpkg](https://unpkg.com/leaflet.markercluster@1.5.3/) | Marker clustering |
| **PapaParse** | 5.5.3 | MIT | [unpkg](https://unpkg.com/papaparse@5.4.1/) | CSV parsing in browser |

---

## APIs & SDKs
 
### Internal API
  
#### Key Route Groups
 
| Route Group | Base Path | Auth Required |
|-------------|-----------|---------------|
| Authentication | `/api/auth` | Varies |
| Uploads / CSV validation | `/api/uploads` | Yes |
| Locations | `/api/locations` | No (public) |
| Scraper | `/api/scraper` | Yes |
| Analytics | `/api/analytics` | Yes |
| Health | `/api/health` | No |
 
For full route signatures and request/response shapes, see `backend/src/routes/`.
 
### SDKs & External Integrations
 
| SDK / Service | Version | Source | Purpose |
|---------------|---------|--------|---------|
| **Prisma ORM** | 5.22.0 | [prisma.io](https://www.prisma.io/docs) | DB access, migrations, type-safe queries. Schema: `backend/prisma/schema.prisma` |
| **Leaflet.js** | 1.9.4 | [leafletjs.com](https://leafletjs.com/reference.html) | Interactive map rendering (CDN) |
| **Selenium** | 4.15.2 | [selenium.dev](https://www.selenium.dev/documentation/) | Headless browser scraping |
| **httpx** | 0.28.1 | [PyPI](https://pypi.org/project/httpx/) | Async HTTP for Python scrapers |
| **requests** | 2.32.5 | [PyPI](https://pypi.org/project/requests/) | HTTP for Python tools |
| **Axios** | 1.12.2 | [npm](https://www.npmjs.com/package/axios) | Frontend HTTP client |
| **jsonwebtoken** | 9.0.2 | [npm](https://www.npmjs.com/package/jsonwebtoken) | Backend JWT signing/verification |
| **Multer** | 1.4.5-lts.1 | [npm](https://www.npmjs.com/package/multer) | Multipart file upload handling |
 
**Integration notes:**
- The public map (`user-frontend`) calls backend endpoints — do not expose `DATABASE_URL` or DB credentials to the browser.
- Prisma is the canonical DB schema source; reconcile any DB documentation against `schema.prisma`.
- If you add or change an endpoint, update `backend/src/routes/*` and the corresponding admin UI call in `admin-frontend/src/services/api.ts`.

### External APIs & SDKs

#### Prisma ORM

- **Version:** 5.22.0
- **Type:** Database ORM
- **Documentation:** [https://www.prisma.io/docs](https://www.prisma.io/docs)
- **License:** Apache-2.0
- **Purpose:** Database access, migrations, and type-safe queries
- **Configuration:** [backend/prisma/schema.prisma](backend/prisma/schema.prisma)

**Features Used:**
- PostgreSQL database provider
- Automated migrations
- Type-safe database client
- Relation management
- Query optimization

#### Leaflet.js Mapping API

- **Version:** 1.9.4
- **Type:** JavaScript mapping library
- **Documentation:** [https://leafletjs.com/reference.html](https://leafletjs.com/reference.html)
- **License:** BSD-2-Clause
- **Source:** [https://unpkg.com/leaflet@1.9.4/](https://unpkg.com/leaflet@1.9.4/)
- **Purpose:** Interactive map rendering and controls

**Features Used:**
- Tile layer management
- Custom markers (regular and premium)
- Popup information windows
- Geographic bounds calculation
- Event handling (click, hover)

#### Selenium WebDriver

- **Version:** 4.15.2
- **Type:** Browser automation framework
- **Documentation:** [https://www.selenium.dev/documentation/](https://www.selenium.dev/documentation/)
- **License:** Apache-2.0
- **Purpose:** Dynamic web scraping and browser automation

**Features Used:**
- Headless browser operation
- JavaScript rendering
- Element interaction
- Page navigation
- Screenshot capture

### Third-Party Integrations

#### Mapbox (Future/Optional)

- **Status:** Planned for future use
- **Purpose:** Enhanced mapping features
- **Configuration:** `MAPBOX_SECRET` in `.env`
- **Documentation:** [https://docs.mapbox.com/](https://docs.mapbox.com/)

---

## License Information
 
### Project License
 
**License:** ISC (Internet Systems Consortium)
**Type:** Private Capstone Project
**Status:** Not for public distribution
 
### Open Source Licenses Summary
 
| License | Libraries | Commercial Use | Modification | Distribution | Private Use |
|---------|-----------|----------------|--------------|--------------|-------------|
| **MIT** | Express, React, Axios, Multer, JWT, most deps | ✅ | ✅ | ✅ | ✅ |
| **Apache-2.0** | TypeScript, Prisma, Requests, Selenium | ✅ | ✅ | ✅ | ✅ |
| **BSD-2-Clause** | Leaflet.js, dotenv | ✅ | ✅ | ✅ | ✅ |
| **LGPL** | psycopg2 | ✅ | ✅ | ✅ | ✅ |
| **ISC** | (This project) | ✅ | ✅ | ✅ | ✅ |
 
All dependencies use permissive open-source licenses compatible with commercial use.
 
### License Compliance
 
- Attribution is maintained in `package.json` and `requirements.txt`.
- No modifications have been made to core libraries.
- All libraries are used as intended by their respective licenses.
- Before adding a new dependency, verify its license is permissive (MIT, Apache-2.0, BSD, or ISC). Avoid GPL-licensed packages unless isolated to a standalone tool.
---

# Database Schema

## Prisma Schema Overview

**File:** [backend/prisma/schema.prisma](backend/prisma/schema.prisma)  
**Database Provider:** PostgreSQL (`directUrl` also configured for direct connections; SQLite for local development)

## Entity Relationship Diagram

```
┌─────────────┐         ┌──────────────────┐         ┌──────────────┐
│    User     │         │     Upload       │───────> │   Location   │
├─────────────┤         ├──────────────────┤         ├──────────────┤
│ id (PK)     │         │ id (PK)          │         │ id (PK)      │
│ username    │         │ filename         │         │ handle       │
│ email       │         │ uploadedBy       │         │ name         │
│ passwordHash│         │ status           │         │ uploadId(FK) │
│ role        │         │ rowsTotal        │         │ latitude     │
│ createdAt   │         │ rowsProcessed    │         │ longitude    │
│ lastLogin   │         │ rowsFailed       │         │ ...70+ fields│
└─────────────┘         │ brandConfig      │         └──────────────┘
                        │ scraperType      │
                        └────────┬─────────┘
                                 │
                        ┌────────┼────────┐
                        │                 │
                        ▼                 ▼
                ┌──────────────┐  ┌────────────┐
                │ValidationLog │  │ ScraperJob │
                ├──────────────┤  ├────────────┤
                │ id (PK)      │  │ id (PK)    │
                │ uploadId(FK) │  │ brandName  │
                │ rowNumber    │  │ status     │
                │ logType      │  │ config     │
                │ message      │  │ uploadId   │
                └──────────────┘  └────────────┘

┌──────────────┐  ┌─────────────────────┐
│ PremiumStore │  │    BrandConfig      │
├──────────────┤  ├─────────────────────┤
│ handle (PK)  │  │ brandId (PK)        │
│ addedAt      │  │ data (Json)         │
│ notes        │  │ createdAt           │
│ storeType    │  │ updatedAt           │
│ isServiceCtr │  └─────────────────────┘
│ premiumKind  │
└──────────────┘
 
┌──────────────────────────────┐  ┌───────────────────────────┐
│  BrandConfigBaselineExclude  │  │     AnalyticsEvent        │
├──────────────────────────────┤  ├───────────────────────────┤
│ brandId (PK)                 │  │ id (PK)                   │
│ createdAt                    │  │ event                     │
│                              │  │ properties                │
│                              │  │ sessionId                 │
│                              │  │ deviceType                │
│                              │  │ createdAt                 │
└──────────────────────────────┘  └───────────────────────────┘
```

## Database Tables

### User

Stores admin and viewer user accounts.

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| id | String | UUID primary key | PK, `@default(uuid())` |
| username | String | Login username | Unique, indexed |
| email | String | User email | Unique, indexed |
| passwordHash | String | Bcrypt password hash | — |
| role | String | User role | Default: `"admin"` (`admin`, `viewer`) |
| createdAt | DateTime | Account creation | `@default(now())` |
| lastLogin | DateTime? | Last login timestamp | Nullable |

**Indexes:** `username`, `email`

---

### Upload

Tracks CSV file uploads and validation status.

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| id | String | UUID primary key | PK, `@default(uuid())` |
| filename | String | Stored filename | — |
| originalFilename | String | Original upload name | — |
| fileSize | Int | File size in bytes | — |
| uploadedBy | String | Username of uploader | Default: `"admin"` |
| uploadedAt | DateTime | Upload timestamp | `@default(now())` |
| status | String | Processing status | Default: `"pending"` |
| validationErrors | String? | JSON error array | Nullable |
| validationWarnings | String? | JSON warning array | Nullable |
| rowsTotal | Int | Total rows in CSV | Default: `0` |
| rowsProcessed | Int | Successfully processed rows | Default: `0` |
| rowsFailed | Int | Failed validation rows | Default: `0` |
| brandConfig | String? | Brand configuration | Nullable |
| scraperType | String? | Scraper type used | Nullable (`json`, `html`, `manual_upload`) |

**Status values:** `pending`, `validating`, `valid`, `invalid`, `processing`, `completed`, `failed`

**Relations:** has many `ValidationLog`, `Location`, `ScraperJob`

**Indexes:** `status`, `uploadedAt`

---

### Location

Stores detailed store location information (70+ fields) with multi-language support.

#### Core Fields

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| id | String | UUID primary key | PK, `@default(uuid())` |
| uploadId | String? | FK → Upload | Nullable, `onDelete: SetNull` |
| handle | String | Unique store identifier | Unique |
| name | String | Store name | — |
| status | Boolean | Active/inactive flag | Default: `true` |
| latitude | Float | Geographic latitude | Required |
| longitude | Float | Geographic longitude | Required |
| isPremium | Boolean | Premium store flag | Default: `false` |
| priority | Int? | Sort priority | Nullable |
| tags | String? | Tag list | Nullable |
| brands | String? | Brand associations | Nullable |
| customBrands | String? | Custom brand overrides | Nullable |
| brandFilterMode | String? | Map brand filter mode (`null` or `"verified_brand"`) | Nullable |

#### Address Fields

| Field | Type | Description |
|-------|------|-------------|
| addressLine1 | String | Required |
| addressLine2 | String? | Optional |
| postalCode | String? | Optional |
| city | String | Required |
| stateProvinceRegion | String? | Optional |
| country | String | Required |

#### Contact Fields

| Field | Type |
|-------|------|
| phone | String? |
| email | String? |
| website | String? |
| imageUrl | String? |

#### Hours (per day, all nullable)

`monday`, `tuesday`, `wednesday`, `thursday`, `friday`, `saturday`, `sunday`

#### SEO Fields

`pageTitle`, `pageDescription`, `metaTitle`, `metaDescription` — all nullable strings.

#### English Translations (for non-Latin names/addresses)

`nameEn`, `addressLine1En`, `cityEn` — all nullable strings.

#### Localization

| Language | Fields |
|----------|--------|
| French (Fr) | `nameFr`, `pageTitleFr`, `pageDescriptionFr`, `customBrandsFr` |
| Chinese Simplified (ZhCn) | `nameZhCn`, `pageTitleZhCn`, `pageDescriptionZhCn`, `customBrandsZhCn` |
| Spanish (Es) | `nameEs`, `pageTitleEs`, `pageDescriptionEs`, `customBrandsEs` |

#### Custom Buttons (×2, with localized variants)

| Button | Fields |
|--------|--------|
| Button 1 (EN) | `customButton1Title`, `customButton1Url` |
| Button 1 (FR) | `customButton1TitleFr`, `customButton1UrlFr` |
| Button 1 (ZH) | `customButton1TitleZhCn`, `customButton1UrlZhCn` |
| Button 1 (ES) | `customButton1TitleEs`, `customButton1UrlEs` |
| Button 2 (EN) | `customButton2Title`, `customButton2Url` |
| Button 2 (FR) | `customButton2TitleFr`, `customButton2UrlFr` |
| Button 2 (ZH) | `customButton2TitleZhCn`, `customButton2UrlZhCn` |
| Button 2 (ES) | `customButton2TitleEs`, `customButton2UrlEs` |

**Indexes:** `uploadId`, `city`, `country`, `isPremium`, `(latitude, longitude)`, `brands`

---

### ValidationLog

Individual validation errors and warnings per upload row.

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| id | String | UUID primary key | PK, `@default(uuid())` |
| uploadId | String | FK → Upload | `onDelete: Cascade` |
| rowNumber | Int? | CSV row number | Nullable |
| logType | String | Log level | `error`, `warning`, `info` |
| fieldName | String? | Field with the issue | Nullable |
| issueType | String | Category of issue | — |
| message | String | Descriptive message | — |
| value | String? | Problematic value | Nullable |
| createdAt | DateTime | Auto-generated | `@default(now())` |

**Indexes:** `uploadId`, `logType`

---

### ScraperJob

Tracks web scraping job execution.

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| id | String | UUID primary key | PK, `@default(uuid())` |
| brandName | String | Brand being scraped | — |
| config | String | JSON configuration | — |
| status | String | Job status | Default: `"queued"` |
| startedAt | DateTime | Job start time | `@default(now())` |
| completedAt | DateTime? | Job completion time | Nullable |
| uploadId | String? | FK → Upload | Nullable, `onDelete: SetNull` |
| errorMessage | String? | Error details | Nullable |
| recordsScraped | Int | Records found | Default: `0` |
| logs | String? | Full scraper output logs | Nullable |

**Status values:** `queued`, `running`, `completed`, `failed`

**Indexes:** `status`, `brandName`

---

### PremiumStore

Tracks stores enrolled in the premium program. Uses `handle` as the primary key (no separate UUID).

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| handle | String | Store handle | PK (matches `Location.handle`) |
| addedAt | DateTime | Enrollment date | `@default(now())` |
| notes | String? | Internal notes | Nullable |
| storeType | String? | e.g. `"AD Verified"` | Nullable |
| isServiceCenter | Boolean | Service center flag | Default: `false` |
| premiumRetailKind | String? | `boutique` or `multi_brand` | Nullable |

---

### BrandConfig

Per-brand scraper configuration persisted to the database, merged over `backend/brand_configs.json` for Railway deployments.

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| brandId | String | Brand identifier | PK |
| data | Json | Configuration payload | — |
| createdAt | DateTime | — | `@default(now())` |
| updatedAt | DateTime | — | `@updatedAt` |

---

### BrandConfigBaselineExclude

Baseline keys from `brand_configs.json` to omit after a rename or delete (the JSON file cannot be patched in production).

| Field | Type | Description |
|-------|------|-------------|
| brandId | String | Brand identifier (PK) |
| createdAt | DateTime | `@default(now())` |

---

### AnalyticsEvent

Stores anonymous client analytics events. No PII is captured — session grouping is via an opaque `sessionId`.

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| id | String | UUID primary key | PK, `@default(uuid())` |
| event | String | Event name (e.g. `store_tapped`, `brand_searched`, `store_phone_tapped`) | — |
| properties | String? | JSON payload: `{ storeId, storeName, brand, source, … }` | Nullable |
| sessionId | String? | Anonymous session identifier | Nullable |
| deviceType | String? | `"ios"` or `"android"` | Nullable |
| createdAt | DateTime | — | `@default(now())` |

**Indexes:** `event`, `createdAt`, `(event, createdAt)`, `sessionId`

---

## Database Operations

**View database (GUI):**
```bash
cd backend
npx prisma studio
```

**Reset database:**
```bash
cd backend
npm run reset-db
npm run seed-admin
npm run import-data -- ./path/to/stores.csv   # optional: reload from CSV
```

**Create a migration after schema changes:**
```bash
cd backend
npx prisma migrate dev --name <migration_name>
npx prisma generate
```

**Deploy migrations (production):**
```bash
npx prisma migrate deploy
```

---

## API Endpoints

### Authentication — `/api/auth`

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| POST | `/api/auth/login` | No | — | Login |
| POST | `/api/auth/logout` | No | — | Logout |
| GET | `/api/auth/me` | Yes | — | Get current user |
| GET | `/api/auth/users` | Yes | `admin` | List all users |

**POST `/api/auth/login`**

Request body:
- `username` (string, required)
- `password` (string, required)

**GET `/api/auth/me`**

Returns the user attached by auth middleware via `userId`.

---

### Uploads — `/api/uploads`

All routes require authentication.

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| POST | `/api/uploads` | Yes | `admin` | Upload CSV file |
| GET | `/api/uploads` | Yes | — | List all uploads |
| GET | `/api/uploads/stats` | Yes | — | Get statistics |
| GET | `/api/uploads/master/download` | Yes | — | Download master CSV file |
| POST | `/api/uploads/manual-store` | Yes | `admin` | Add one location via validation + import |
| POST | `/api/uploads/geocode-address` | Yes | `admin` | Look up lat/lon for manual add form |
| GET | `/api/uploads/:id` | Yes | — | Get single upload details |
| GET | `/api/uploads/:id/logs` | Yes | — | Get validation logs for upload |
| GET | `/api/uploads/:id/download` | Yes | — | Download upload CSV file |
| POST | `/api/uploads/:id/revalidate` | Yes | `admin` | Re-validate upload |
| DELETE | `/api/uploads/:id` | Yes | `admin` | Delete upload |

**GET `/api/uploads`** — query parameters:
- `page` (integer, optional)
- `limit` (integer, optional)
- `status` (string, optional)

**GET `/api/uploads/master/download`** — accepts the same filters as `GET /api/scraper/master-csv/records` via `masterExportFiltersFromQuery`.

**GET `/api/uploads/:id/logs`** — query parameters:
- `logType` (string, optional)
- `page` (integer, optional)
- `limit` (integer, optional)

**POST `/api/uploads/:id/revalidate`** — request body:
- `autoFix` (boolean, optional — defaults to `true`)
- `checkUrls` (boolean, optional — defaults to `false`)

**POST `/api/uploads/geocode-address`** — returns `{ success, latitude, longitude }` on success. Error codes: `bad_input` (400), `unconfigured` (503), `not_found` (404), provider error (502).

---

### Locations — `/api/locations`

All routes are public (no authentication required).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/locations` | List all locations |
| GET | `/api/locations/nearby` | Find locations near coordinates |
| GET | `/api/locations/search` | Search locations by name or address |
| GET | `/api/locations/brands` | Get list of all unique brands |
| GET | `/api/locations/stats` | Get location statistics |
| GET | `/api/locations/:id` | Get single location by ID |

**GET `/api/locations`** — query parameters:
- `brand` (string, optional)
- `country` (string, optional)
- `city` (string, optional)
- `status` (`true` | `false`, optional)
- `search` (string, optional)
- `limit` (integer, optional — defaults to `100`)
- `offset` (integer, optional — defaults to `0`)

**GET `/api/locations/nearby`** — query parameters:
- `lat` (float, required)
- `lng` (float, required)
- `radius` (float, optional — defaults to `25` miles)
- `brand` (string, optional)
- `country` (string, optional)
- `city` (string, optional)
- `status` (`true` | `false`, optional)

**GET `/api/locations/search`** — query parameters:
- `q` (string, required)
- `limit` (integer, optional — defaults to `50`)

---

### Analytics — `/api/analytics`

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| POST | `/api/analytics/events` | No | — | Record a single event (mobile app) |
| POST | `/api/analytics/events/batch` | No | — | Record a batch of events (mobile app) |
| GET | `/api/analytics/summary` | Yes | `admin`, `viewer` | Get summary |
| GET | `/api/analytics/retailers` | Yes | `admin`, `viewer` | Get retailer analytics |
| GET | `/api/analytics/brands` | Yes | `admin`, `viewer` | Get brand analytics |
| GET | `/api/analytics/actions` | Yes | `admin`, `viewer` | Get action analytics |
| GET | `/api/analytics/sources` | Yes | `admin`, `viewer` | Get source analytics |
| GET | `/api/analytics/daily` | Yes | `admin`, `viewer` | Get daily analytics |

**POST `/api/analytics/events`** — request body:
- `event` (string, required)
- `properties` (any, optional)
- `sessionId` (any, optional)
- `deviceType` (any, optional)

**POST `/api/analytics/events/batch`** — request body:
- `events` (array, required — max 100 items; each item must have an `event` string field)

**GET admin analytics endpoints** — all accept query parameter:
- `days` (integer, optional — defaults to `30`)

---

### Premium — `/api/premium`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/premium/images/:filename` | No | Serve store image |
| GET | `/api/premium/names` | No | Get premium store names |
| POST | `/api/premium/reconcile` | Yes | Reconcile `isPremium` flags on `Location` against `PremiumStore` |
| GET | `/api/premium/stores` | Yes | List premium stores |
| PATCH | `/api/premium/stores/:handle` | Yes | Update a premium store |
| POST | `/api/premium/stores/:handle/image` | Yes | Upload store image (multipart field: `image`) |
| POST | `/api/premium/stores` | Yes | Mark stores as premium |
| DELETE | `/api/premium/stores` | Yes | Remove premium status |

**PATCH `/api/premium/stores/:handle`** — patchable fields:
`addressLine1`, `addressLine2`, `city`, `stateProvinceRegion`, `postalCode`, `country`, `phone`, `website`, `imageUrl`, `pageDescription`, `brands`, `monday`–`sunday`, `isPremium` (boolean), `isServiceCenter` (boolean), `premiumRetailKind` (`"boutique"` | `"multi_brand"` | `null`), `brandFilterMode` (`"brand"` | `"verified_brand"` | `null` | `""`)

**POST `/api/premium/stores`** — request body:
- `entries` (array, required — each entry must have `handle` (string), `isServiceCenter` (boolean), `premiumRetailKind` (`"boutique"` | `"multi_brand"`))

**DELETE `/api/premium/stores`** — request body:
- `handles` (array of strings, required)

---

### Scraper — `/api/scraper`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/scraper/brands` | List brand configs (excludes `_README` and disabled) |
| GET | `/api/scraper/brands/:id` | Get a specific brand config |
| POST | `/api/scraper/brands` | Save discovered endpoint as brand config |
| POST | `/api/scraper/jobs` | Create scraper job |
| GET | `/api/scraper/jobs` | List scraper jobs |
| GET | `/api/scraper/jobs/:id` | Get scraper job details |
| GET | `/api/scraper/jobs/:id/logs` | Get job logs |
| GET | `/api/scraper/jobs/:id/records` | Get records for a completed job |
| PATCH | `/api/scraper/jobs/:id/records` | Save job records to job CSV and append to master |
| GET | `/api/scraper/jobs/:id/dropped-records` | Get dropped/excluded records (completed jobs only) |
| POST | `/api/scraper/jobs/:id/cancel` | Cancel a running job |
| DELETE | `/api/scraper/jobs/:id` | Delete a job (not allowed if status is `running`) |
| GET | `/api/scraper/master-csv/countries` | Get distinct countries from master CSV |
| GET | `/api/scraper/master-csv/records` | Get master store records |
| PATCH | `/api/scraper/master-csv` | Update Location rows in DB directly |
| DELETE | `/api/scraper/master-csv/records` | Remove a single store from master by handle |
| POST | `/api/scraper/verify-coordinates` | Start geo-verify + dedup pipeline for a brand |
| GET | `/api/scraper/verify-coordinates/:taskId` | Poll coordinate verification task status |
| GET | `/api/scraper/stats` | Get scraper statistics |
| POST | `/api/scraper/discover` | Discover endpoints from a store locator page (5 min timeout) |

**POST `/api/scraper/jobs`** — request body:
- `brandName` (string, required)
- `url` (string, required)
- `region` (string, optional — defaults to `"world"`)

**GET `/api/scraper/jobs`** — query parameters:
- `status` (string, optional)
- `brandName` (string, optional)
- `limit` (integer, optional — defaults to `50`)
- `offset` (integer, optional — defaults to `0`)

**PATCH `/api/scraper/jobs/:id/records`** — request body:
- `records` (array of objects, required — at least one record)

**DELETE `/api/scraper/master-csv/records`** — request body:
- `handle` (string, required)

**PATCH `/api/scraper/master-csv`** — request body:
- `rows` (array of objects, required — at least one record)

**POST `/api/scraper/verify-coordinates`** — request body:
- `brandName` (string, required)

Returns `{ taskId }` (HTTP 202). Poll status via `GET /api/scraper/verify-coordinates/:taskId`.

**POST `/api/scraper/brands`** — request body:
- `brandId` (string, required)
- `endpoint` (object, required — must include `url`)
- `brandName` (string, optional)
- `suggestedConfig` (object, optional)
- `overwrite` (boolean, optional)
- `oldBrandId` (string, optional — triggers rename of old DB row when it differs from `brandId`)

Returns HTTP 409 if an exact or similar config already exists and `overwrite` is not `true`.

**POST `/api/scraper/discover`** — request body:
- `url` (string, required)

Spawns the `endpoint_discoverer.py` Python script. Times out after 5 minutes.

---

### Health — `/health`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Simple ping / uptime check |
| GET | `/health/details` | Yes | Full service health report |
| GET | `/health/dashboard` | Yes | Visual HTML status page |

**GET `/health`** — returns `{ status: "ok", timestamp, service }`.

**GET `/health/details`** — returns HTTP 200 for `healthy` or `degraded`, HTTP 503 for unhealthy.

---

## Additional Resources

- **Main README:** [README.md](README.md)
- **Backend Documentation:** [backend/README.md](backend/README.md)
- **ADMIN Frontend Documentation:** [admin-frontend/README.md](admin-frontend/README.md)
- **USER Frontend Documentation:** [user-frontend/README.md](user-frontend/README.md)
- **Reset Guide:** [RESET_GUIDE.md](RESET_GUIDE.md)

---
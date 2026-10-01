FROM node:20-slim

# Install Python 3, Chromium (for endpoint discoverer), and system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    chromium \
    chromium-driver \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy entire repo so Prototypes/ and tools/ are available in the container
COPY . .

# Install all Python dependencies from requirements.txt
RUN python3 -m venv /app/venv && \
    /app/venv/bin/pip install --no-cache-dir -r /app/requirements.txt

# Install Node dependencies, generate Prisma client, and build TypeScript
WORKDIR /app/backend
RUN npm ci
RUN npx prisma generate
RUN npm run build

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PYTHON_PATH=/app/venv/bin/python3

EXPOSE 8080

CMD ["node", "dist/server.js"]

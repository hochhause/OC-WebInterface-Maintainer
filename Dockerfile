# --- build the client (vite writes into ../server/public) ---
FROM node:20-slim AS client
WORKDIR /app
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci
COPY client ./client
RUN cd client && npm run build

# --- install server deps (better-sqlite3 compiles if no prebuild matches) ---
FROM node:20-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# --- runtime ---
FROM node:20-slim
WORKDIR /app/server
ENV NODE_ENV=production
# The database lives on the mounted volume, never in the image layer.
ENV DATA_DIR=/data
COPY --from=deps /app/server/node_modules ./node_modules
COPY server ./
COPY --from=client /app/server/public ./public
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "index.js"]

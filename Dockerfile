# --- build the client (vite writes into ../server/public) ---
FROM node:22-slim AS client
WORKDIR /app
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci
COPY client ./client
RUN cd client && npm run build

# --- install server deps, then prove the native module actually works ---
# Node 22, not 20: better-sqlite3 declares engines >=22 and ships a prebuilt
# binary built for it. Loading that binary on Node 20 does not fail cleanly, it
# segfaults the moment a database is opened -- a container that crash-loops with
# no log output at all. The smoke test below turns that into a build error
# instead of a 3am debugging session. If it ever fails, either the engine
# mismatch is back, or this host cannot run Node+SQLite in a container at all
# (some Docker Desktop/WSL2 setups cannot -- check with a stock node image).
FROM node:22-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev \
 && node -e "const D = require('better-sqlite3'); new D(':memory:').exec('create table t (a)'); console.log('better-sqlite3 ok')"

# --- runtime ---
FROM node:22-slim
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

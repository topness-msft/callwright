FROM node:20-alpine
WORKDIR /app

# Install deps first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# App source (static code, prompts, schema, seed scenario-profiles.json).
COPY . .

# Mutable state lives on a persistent volume (see fly.toml / docker run -v).
# server.js seeds scenario-profiles.json onto CALLWRIGHT_DATA_DIR on first boot.
ENV PORT=8787 \
    CALLWRIGHT_DATA_DIR=/data

EXPOSE 8787

CMD ["node", "server.js"]

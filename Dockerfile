FROM node:22-slim

# Native build deps for @discordjs/opus and sodium-native, plus ffmpeg for the
# Whisper/Groq path (silence removal, chunk encoding, in-person uploads).
RUN apt-get update && apt-get install -y \
    python3 make g++ libopus-dev libsodium-dev ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN npx tsc

# Run
CMD ["node", "dist/index.js"]

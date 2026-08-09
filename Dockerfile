FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Copy package manifests and install exact pinned dependencies.
# NOTE: Do NOT add --omit=dev; tsx is in devDependencies and is required to run TypeScript in production.
COPY package*.json ./
RUN npm ci

# Copy application source
COPY . .

# Set default server port
ENV PORT=3000
EXPOSE 3000

# Start server using --env-file-if-exists flag
CMD ["npm", "run", "start"]

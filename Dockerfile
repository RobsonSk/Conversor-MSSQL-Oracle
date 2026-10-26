# Dockerfile
FROM node:18-slim

# Install system dependencies required for Oracle Instant Client
RUN apt-get update && apt-get install -y --no-install-recommends \
    libaio1 \
    unzip \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set up Oracle directory
WORKDIR /opt/oracle

# Download and extract Oracle Instant Client 19.22 (fully compatible with Oracle 11g)
RUN wget https://download.oracle.com/otn_software/linux/instantclient/1922000/instantclient-basiclite-linux.x64-19.22.0.0.0dbru.zip \
    && unzip instantclient-basiclite-linux.x64-19.22.0.0.0dbru.zip \
    && rm instantclient-basiclite-linux.x64-19.22.0.0.0dbru.zip

# Configure environment variables for Oracle Thick Mode
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient_19_22
ENV ORACLE_CLIENT_DIR=/opt/oracle/instantclient_19_22

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Create log and checkpoint directories
RUN mkdir -p logs checkpoints

# Set environment to production
ENV NODE_ENV=production

# Run the migration
CMD ["node", "dist/index.js"]

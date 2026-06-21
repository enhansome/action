# ---- Builder Stage ----
FROM node:24 AS builder

LABEL stage="builder"
LABEL maintainer="v1nvn"

WORKDIR /app

# Copy application dependency manifests
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for building)
RUN npm ci

# Copy TypeScript configuration and source code
COPY tsconfig.json .
COPY src ./src

# Compile TypeScript to JavaScript
RUN npm run build

# Prune devDependencies to prepare for copying to the runner stage
# This ensures only production dependencies are in node_modules when copied.
RUN npm prune --omit=dev

# ---- Runner Stage ----
FROM node:24-slim AS runner

LABEL stage="runner"
LABEL description="Enhances markdown files with GitHub star counts."
LABEL maintainer="v1nvn"
# x-release-please-start-version
LABEL version="v1.8.4"
# x-release-please-end

WORKDIR /app

# Copy production dependencies from the builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled JavaScript from the builder stage
COPY --from=builder /app/dist ./dist

# Copy the entrypoint script
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Set the entrypoint for the container
ENTRYPOINT ["/app/entrypoint.sh"]

# Build stage — full dev dependencies for the TypeScript compile.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage — production dependencies only.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Token state lives on a volume so a redeploy doesn't force re-authorizing
# the connector in Claude.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8092
CMD ["node", "dist/index.js"]

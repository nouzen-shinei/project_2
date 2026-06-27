# Multi-stage build for backend-runtime
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# Install all deps including dev for TypeScript compilation
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg is required for server-side video transcoding (HEVC → H.264).
# Alpine's ffmpeg package includes H.264 (libx264) and AAC encoders.
RUN apk add --no-cache ffmpeg

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
EXPOSE 8080
CMD ["node","dist/server.js"]

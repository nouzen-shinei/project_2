# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist
COPY templates ./templates
COPY .env.example ./
# App listens on PORT (default 8090)
ENV PORT=8090
EXPOSE 8090
CMD ["node","dist/server.js"]

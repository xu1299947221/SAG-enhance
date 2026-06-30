FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json vite.config.ts postcss.config.js tailwind.config.js ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY config ./config
COPY migrations ./migrations
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system sag && useradd --system --gid sag --home /app sag
COPY --from=build --chown=sag:sag /app/package.json /app/package-lock.json ./
COPY --from=build --chown=sag:sag /app/node_modules ./node_modules
COPY --from=build --chown=sag:sag /app/dist ./dist
COPY --from=build --chown=sag:sag /app/web/dist ./web/dist
COPY --from=build --chown=sag:sag /app/migrations ./migrations
USER sag
EXPOSE 4173
CMD ["node", "dist/src/index.js"]

FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY web ./web
COPY server/video-types.js ./server/video-types.js
COPY server/audio-types.js ./server/audio-types.js
COPY vite.config.js ./
RUN pnpm build

FROM node:24.19.0-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24.19.0-bookworm-slim AS runtime
ARG VCS_REF=unknown
ARG VERSION=0.13.0-beta
LABEL org.opencontainers.image.title="Mirea" \
      org.opencontainers.image.description="Shared video, audio and book library" \
      org.opencontainers.image.source="https://github.com/SUIREN-KazutoHashimoto/Mirea" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-noto-cjk ffmpeg && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data XDG_CACHE_HOME=/tmp/mirea-cache
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node package.json LICENSE ./
RUN mkdir /data && chown node:node /data
USER 1000:1000
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "server/healthcheck.mjs"]
CMD ["node", "server/index.js"]

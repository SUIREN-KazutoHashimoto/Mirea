FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY web ./web
COPY server/video-types.js ./server/video-types.js
COPY server/audio-types.js ./server/audio-types.js
COPY vite.config.js ./
COPY scripts/pwa-icons.mjs ./scripts/pwa-icons.mjs
RUN pnpm build

FROM node:24.19.0-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24.19.0-bookworm-slim AS sandbox-build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev && rm -rf /var/lib/apt/lists/*
COPY container/launcher.c /build/launcher.c
RUN gcc -std=c11 -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE -pie -Wl,-z,relro,-z,now -o /build/mirea-launch /build/launcher.c

FROM node:24.19.0-bookworm-slim AS runtime
ARG VCS_REF=unknown
ARG VERSION=0.15.3-beta
LABEL org.opencontainers.image.title="Mirea" \
      org.opencontainers.image.description="Shared video, audio and book library" \
      org.opencontainers.image.source="https://github.com/SUIREN-KazutoHashimoto/Mirea" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-noto-cjk ffmpeg && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data XDG_CACHE_HOME=/tmp/mirea-cache
WORKDIR /app
COPY --from=sandbox-build /build/mirea-launch /usr/local/bin/mirea-launch
# Runtime users must not own executable code, including the default UID 1000.
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY package.json LICENSE ./
COPY scripts/prepare-media-storage.mjs ./scripts/prepare-media-storage.mjs
RUN chmod -R go-w /app /usr/local/bin/mirea-launch && mkdir -p /data /media && chown node:node /data /media
USER 1000:1000
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "server/healthcheck.mjs"]
ENTRYPOINT ["/usr/local/bin/mirea-launch"]
CMD ["/usr/local/bin/node", "/app/server/container-entry.mjs"]

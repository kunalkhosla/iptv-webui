FROM node:22-alpine

# ffmpeg + Intel VAAPI stack for Quick Sync hardware H.264 transcoding
# (intel-media-driver = iHD, for Gen8+ iGPUs like the i5-10500T's UHD 630).
# The container must be run with `--device /dev/dri`; server.js probes at
# boot and falls back to software libx264 if the GPU isn't available.
RUN apk add --no-cache ffmpeg intel-media-driver libva-utils
ENV LIBVA_DRIVER_NAME=iHD

# yt-dlp for native trailers (/api/trailer/:key.mp4). Pinned standalone musl
# build (no Python needed), checksum-verified. YouTube's JS challenges are
# solved with the image's own node (`--js-runtimes node`). At runtime the
# server keeps a self-updated copy on the data volume (`yt-dlp -U` weekly and
# after repeated failures) and uses whichever is newer.
ARG YTDLP_VERSION=2026.10.26
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) f=yt-dlp_musllinux;         sha=e97a4dd919221d233e7720e18fa3f66db60fbd1d8c0846bf6deb8e88e04475a8 ;; \
      arm64) f=yt-dlp_musllinux_aarch64; sha=ea97b8564667f3cabc334c3216526de39bc684e99815ecf07b6642f4cba8af4d ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac; \
    wget -qO /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${f}"; \
    echo "${sha}  /usr/local/bin/yt-dlp" | sha256sum -c -; \
    chmod 755 /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public
COPY lib ./lib

ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "server.js"]

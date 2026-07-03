FROM node:20-alpine

# ffmpeg + Intel VAAPI stack for Quick Sync hardware H.264 transcoding
# (intel-media-driver = iHD, for Gen8+ iGPUs like the i5-10500T's UHD 630).
# The container must be run with `--device /dev/dri`; server.js probes at
# boot and falls back to software libx264 if the GPU isn't available.
RUN apk add --no-cache ffmpeg intel-media-driver libva-utils
ENV LIBVA_DRIVER_NAME=iHD

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

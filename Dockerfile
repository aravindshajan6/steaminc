# Single-service image for platforms that run ONE container per service and give it
# ONE public port — Render's free tier, Fly, Railway, Heroku-likes.
#
# The split nginx + node setup in docker-compose.yml is the better architecture and
# is what you want on a VPS. It does not fit a free Render plan, because free web
# services cannot receive private network traffic, so nginx could never reach the
# backend privately. Here node serves the static files itself (the same fallback
# that makes bare `npm start` work) and there is nothing private to reach.
#
# Local/VPS  -> docker compose up      (nginx + node, backend unpublished)
# Render/Fly -> this file              (one container, one port)

FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/app/state

WORKDIR /app

# Backend resolves the UI at ../frontend/public relative to itself, so the two
# directories must keep their relative positions inside the image.
COPY backend/package.json ./backend/
COPY backend/server.js backend/archive.js backend/auth.js ./backend/
COPY backend/data ./backend/data
COPY frontend/public ./frontend/public

# On Render's free plan this is ephemeral — no persistent disks — so accounts do
# not survive a restart. See the deploy notes in the README before relying on it.
RUN mkdir -p /app/state && chown -R node:node /app/state

USER node

# Hosts inject their own PORT; this is the fallback for a plain `docker run`.
ENV PORT=5173
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/server.js"]

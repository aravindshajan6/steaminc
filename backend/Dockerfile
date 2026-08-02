# The app has zero npm dependencies, so there is no install step and no node_modules
# layer to cache — the image is the runtime plus five source files.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=5173 \
    DATA_DIR=/app/state

WORKDIR /app

COPY package.json ./
COPY server.js archive.js auth.js ./
COPY data ./data

# Writable state (accounts, sessions) lives outside /app/data so a mounted volume
# cannot shadow the bundled demo.json. Owned by the unprivileged user that runs node.
RUN mkdir -p /app/state && chown -R node:node /app/state

USER node

EXPOSE 5173

# No curl or wget assumptions — use the runtime that is guaranteed to be here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

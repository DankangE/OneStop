FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7175
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R node:node /app
COPY --chown=node:node server.mjs index.html styles.css arcade.css app.js ./
COPY --chown=node:node sim/ ./sim/

USER node
EXPOSE 7175
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7175/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

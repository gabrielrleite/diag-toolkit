FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY web/ ./web/
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/info >/dev/null || exit 1
CMD ["node", "server.js"]

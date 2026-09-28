FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]

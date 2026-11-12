FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# Когда появится package-lock.json — заменить на `npm ci --omit=dev`
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY migrations ./migrations
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.ts"]

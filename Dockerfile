FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
COPY public ./public
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs agp_mechanical_screen.csv ./
COPY public ./public
COPY data ./data
COPY lib ./lib
COPY scripts ./scripts
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.mjs"]

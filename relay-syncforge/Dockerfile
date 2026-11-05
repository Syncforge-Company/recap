FROM node:22-slim
WORKDIR /relay
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.mjs ./
ENV RELAY_HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "server.mjs"]

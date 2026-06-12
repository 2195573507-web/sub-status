FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY server.js ./
COPY public ./public
EXPOSE 3001
CMD ["node", "server.js"]

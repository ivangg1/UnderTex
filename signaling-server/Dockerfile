FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 4444
ENV PORT=4444
CMD ["node", "server.js"]

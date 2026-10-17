FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm install --omit=dev
COPY server/src ./src
COPY public ./public
COPY server/test ./test
ENV PORT=4000
EXPOSE 4000
CMD ["npm", "start"]

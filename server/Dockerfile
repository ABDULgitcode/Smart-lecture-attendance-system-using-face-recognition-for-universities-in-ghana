FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
COPY test ./test
ENV PORT=4000
EXPOSE 4000
CMD ["npm", "start"]

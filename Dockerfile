FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .
RUN npx tsc --build
EXPOSE 3978
CMD ["node", "./lib/index.js"]
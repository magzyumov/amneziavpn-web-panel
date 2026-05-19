FROM node:20-alpine

# Build deps for native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src

EXPOSE 3001
CMD ["npm", "start"]

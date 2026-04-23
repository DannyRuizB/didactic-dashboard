FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      iputils-ping \
      openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]

FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      iputils-ping \
      openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# --ignore-scripts: better-sqlite3 13 ships its prebuilt binaries inside the
# package but has no install script, so npm falls back to an implicit
# `node-gyp rebuild`, which needs python3 and make (not in node:24-slim) and
# fails the build. Nothing here needs to compile: the prebuilt binary loads.
RUN npm install --omit=dev --ignore-scripts

COPY src/ ./src/

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]

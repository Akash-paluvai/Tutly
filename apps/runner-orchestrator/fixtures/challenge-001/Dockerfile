FROM node:22-alpine

WORKDIR /opt/tutly-runtime

COPY package*.json ./

RUN npm install --no-audit --no-fund

ENV NODE_PATH=/opt/tutly-runtime/node_modules
ENV PATH=/opt/tutly-runtime/node_modules/.bin:$PATH
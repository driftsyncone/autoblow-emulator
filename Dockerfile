# Build and run:
#   docker build -t autoblow-emulator .
#   docker run --rm -p 127.0.0.1:8792:8792 -v autoblow-emulator-data:/data autoblow-emulator
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY dist ./dist
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8792
# The devices file is kept in /data; it has to belong to the user the server runs as.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
# Inside the container it listens on every interface; publish the port on 127.0.0.1 (as above) unless
# other machines should reach it.
CMD ["node", "dist/server.js", "--host", "0.0.0.0", "--data", "/data/devices.json"]

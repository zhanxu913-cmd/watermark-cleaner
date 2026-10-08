# 视频处理服务镜像
# 云托管里的「服务」直接指向本目录，构建时会读取这个 Dockerfile

FROM node:18-slim

ENV NODE_ENV=production \
    PORT=80 \
    WORK_DIR=/tmp/wm \
    MAX_CONCURRENT=2 \
    MAX_INPUT_MB=500

# ffmpeg 是硬依赖：小程序端无法在本地跑 FFmpeg，视频处理必须落到这个容器里
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version | head -n 1

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

COPY . .

EXPOSE 80

CMD ["node", "server.js"]

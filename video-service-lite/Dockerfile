# 极简视频服务镜像
# 体积约 250MB（node:20-alpine + ffmpeg），可部署到云托管 / 任意容器平台

FROM node:20-alpine

# alpine 的 ffmpeg 包带 libx264，正好满足转码需要
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# 工作目录（上传中转 + 产物），挂卷可避免容器重建丢文件
RUN mkdir -p /app/.work/incoming /app/.work/output

ENV PORT=8080
ENV WORK_DIR=/app/.work
EXPOSE 8080

CMD ["node", "server.js"]

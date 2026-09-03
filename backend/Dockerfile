# ===== 构建阶段 =====
FROM node:20-slim AS builder
WORKDIR /app

# 换阿里云 Debian 镜像源 + npm 淘宝镜像（国内服务器速度起飞）
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list 2>/dev/null || true
RUN npm config set registry https://registry.npmmirror.com

# 安装编译依赖 + OpenSSL（Prisma 需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ openssl libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用 Docker 缓存）
COPY package*.json ./
RUN npm ci --no-audit --no-fund

# 再复制源码构建
COPY . .
RUN npx prisma generate && npm run build

# ===== 运行阶段 =====
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# 换源 + 安装 OpenSSL
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list 2>/dev/null || true
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
# 注意：.env 不打进镜像，由 docker-compose 通过 environment 注入

EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/main.js"]

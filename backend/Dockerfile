# ===== 构建阶段 =====
# 用 Debian slim 而不是 Alpine：bcrypt 有预编译二进制，Prisma 需要的 OpenSSL 也自带
FROM node:20-slim AS builder
WORKDIR /app

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

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
# 注意：.env 不打进镜像，由 docker-compose 通过 environment 注入

EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/main.js"]

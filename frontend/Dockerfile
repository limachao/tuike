# ===== 构建阶段 =====
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ===== 运行阶段 =====
FROM nginx:alpine AS runner

# 把构建产物放到 nginx 默认目录
COPY --from=builder /app/dist /usr/share/nginx/html

# 覆盖 nginx 配置（SPA 路由 fallback + 反代后端）
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

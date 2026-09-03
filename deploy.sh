#!/bin/bash
# ============================================================
# 推课神器 - 一键部署脚本
# 用法：在服务器项目根目录执行  bash deploy.sh
# ============================================================
set -e

echo "=========================================="
echo "  推课神器 · 一键部署"
echo "=========================================="

# ---- 1. 检查 Docker ----
if ! command -v docker &> /dev/null; then
    echo "❌ 没找到 Docker，请先装 Docker"
    exit 1
fi
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "❌ 没找到 Docker Compose"
    exit 1
fi
echo "✅ Docker 已就绪"

# ---- 2. 准备 .env ----
if [ ! -f .env ]; then
    if [ -f .env.prod ]; then
        cp .env.prod .env
        echo "✅ 已从 .env.prod 复制 .env"
    else
        echo "❌ 没找到 .env 文件"
        exit 1
    fi
fi

# ---- 3. 构建并启动 ----
echo ""
echo "📦 正在构建 Docker 镜像..."
docker compose build --no-cache

echo ""
echo "🚀 正在启动容器..."
docker compose up -d

echo ""
echo "⏳ 等数据库起来（10秒）..."
sleep 10

# ---- 4. 数据库初始化 ----
echo ""
echo "🗄️  正在推送数据库表结构..."
docker compose exec -T backend npx prisma db push --accept-data-loss 2>/dev/null || echo "⚠️  数据库可能还没起来，稍后可以手动执行：docker compose exec backend npx prisma db push"

# ---- 5. 显示状态 ----
echo ""
echo "=========================================="
echo "  ✅ 部署完成！"
echo "=========================================="
echo ""
echo "容器状态："
docker compose ps
echo ""
echo "访问地址：http://$(curl -s ifconfig.me 2>/dev/null || echo '服务器IP'):8080"
echo ""
echo "常用命令："
echo "  查看日志：  docker compose logs -f"
echo "  重启：      docker compose restart"
echo "  停止：      docker compose down"
echo "  更新后部署：bash deploy.sh"
echo ""

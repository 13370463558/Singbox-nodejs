#!/bin/bash

cd "$(dirname "$0")"

chmod +x ./index.js 2>/dev/null || true

if [ ! -d "node_modules" ] && [ -f "package.json" ]; then
    echo "[INFO] 正在安装 Node.js 依赖..."
    npm install --production --no-audit --no-fund
fi

mkdir -p .tmp

export MALLOC_ARENA_MAX=2

TOTAL_RAM_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')

if [ -z "$TOTAL_RAM_MB" ] || [ "$TOTAL_RAM_MB" -eq 0 ]; then
    TOTAL_RAM_MB=128
fi

if [ "$TOTAL_RAM_MB" -lt 160 ]; then
    NODE_MEM=40
elif [ "$TOTAL_RAM_MB" -lt 256 ]; then
    NODE_MEM=64
elif [ "$TOTAL_RAM_MB" -lt 320 ]; then
    NODE_MEM=96
elif [ "$TOTAL_RAM_MB" -lt 448 ]; then
    NODE_MEM=128
elif [ "$TOTAL_RAM_MB" -lt 576 ]; then
    NODE_MEM=160
else
    NODE_MEM=256
fi

echo "[INFO] 检测到系统内存: ${TOTAL_RAM_MB}MB | Node.js 堆上限设为: ${NODE_MEM}MB"
echo "[INFO] 启动 Argo + TUIC 主程序 (index.js)..."

NODE_CMD="node --expose-gc --max-old-space-size=${NODE_MEM} index.js"

while true; do
    $NODE_CMD
    
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 0 ]; then
        echo "[INFO] 主程序已正常退出。"
        break
    fi
    
    if [ $EXIT_CODE -eq 130 ] || [ $EXIT_CODE -eq 143 ]; then
        echo "[INFO] 收到系统终止信号，停止保活。"
        break
    fi
    
    echo "[警告] index.js 意外异常退出 (错误码: $EXIT_CODE)，5 秒后尝试自动重启..."
    sleep 5
done

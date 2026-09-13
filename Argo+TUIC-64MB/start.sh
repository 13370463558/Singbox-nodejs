#!/bin/bash

cd "$(dirname "$0")"

chmod +x ./index.js 2>/dev/null || true

mkdir -p .tmp

echo "[INFO] 启动 Argo + TUIC 主程序 (index.js)..."

while true; do

    node --max-old-space-size=32 index.js
    
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 0 ]; then
        echo "[INFO] 主程序已正常退出。"
        break
    fi
    
    echo "[警告] index.js 意外异常退出 (错误码: $EXIT_CODE)，5 秒后尝试自动重启..."
    sleep 5
done

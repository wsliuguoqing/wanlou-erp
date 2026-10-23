#!/bin/bash
# 简单推送脚本 - 在 Git Bash 中运行

cd "$(dirname "$0")"

echo "================================"
echo "推送到 GitHub"
echo "================================"
echo ""

# 添加文件
echo "[1/3] 添加文件..."
git add index.html v2-full.html

# 提交
echo "[2/3] 提交..."
git commit -m "更新:完整可交互原型-包含出库/入库/客户/物料/库存/报表"

# 推送
echo "[3/3] 推送..."
git push

echo ""
echo "================================"
echo "✓ 推送完成!"
echo "================================"
echo ""
echo "访问地址:"
echo "https://wsliuguoqing.github.io/wanlou-erp/prototype/index.html"
echo ""

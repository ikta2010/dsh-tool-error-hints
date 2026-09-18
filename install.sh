#!/usr/bin/env bash
# 把 dsh-tool-error-hints 装进 web profile（幂等）。
#
# 注意：本脚本**只负责建立模块解析所需的软链**。
# 插件的激活**不写进 package.json 的 dsh.profile.bundles**——实测 `dsh web`
# 每次启动会把 package.json 还原成出厂版本，手工加进去的条目会被冲掉。
# 激活统一在 ~/.dsh/profiles/web/cordis.patch.yml 里用 insert 完成（该文件不会被重写）。
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROF="$HOME/.dsh/profiles/web"
DSH_MODULES="$HOME/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"

echo "== 1. 补齐 peer 依赖软链 =="
mkdir -p "$SRC/node_modules/@deepseek-ai"
for pkg in schemastery dsh-llm cordis; do
  if [ -d "$DSH_MODULES/$pkg" ]; then
    ln -sfn "$DSH_MODULES/$pkg" "$SRC/node_modules/@deepseek-ai/$pkg"
    echo "   ✅ $pkg"
  else
    echo "   ⚠️ 未找到 $pkg（dsh 安装路径变了？）"
  fi
done

echo "== 2. 软链进 profile/node_modules =="
mkdir -p "$PROF/node_modules"
ln -sfn "$SRC" "$PROF/node_modules/dsh-tool-error-hints"
echo "   ✅ $PROF/node_modules/dsh-tool-error-hints -> $SRC"

echo "== 3. 自检：模块能否被 import =="
( cd "$PROF" && node -e "import('dsh-tool-error-hints').then(m=>console.log('   ✅ 导出:',Object.keys(m).join(', '))).catch(e=>{console.error('   ❌',e.code,e.message);process.exit(1)})" )

echo "== 4. 自检：配置树是否包含插件 =="
dsh --profile web --dump-config 2>&1 | grep -A3 "id: tool-error-hints" || \
  echo "   ⚠️ 未在配置树里找到 —— 请确认 cordis.patch.yml 里已加 insert 条目"

echo
echo "== 完成 =="
echo "   生效需要重启 dsh web： dsh-restart"
echo "   确证加载： tail -1 ~/.dsh-logs/tool-error-hints-loaded.log"

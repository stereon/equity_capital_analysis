#!/usr/bin/env bash
# ===================================================================
# Equilytic 一键部署脚本（Ubuntu + Python venv + systemd）
# ===================================================================
# 自动完成：装系统依赖 / 建 venv 装依赖 / 构建前端 / 安装并启用 systemd 服务。
# 无法自动、需你手动的三件事，脚本结束会再提示一遍：
#   1) 写 /opt/equilytic/.env（密钥）   2) claude login（用本机器人运行账号）   3) 云安全组放行端口
#
# 用法（在服务器上，以有 sudo 的部署账号执行）：
#   sudo -v
#   APP_USER=$USER bash scripts/deploy/setup.sh
# 可用环境变量覆盖默认值：
#   APP_DIR(默认 /opt/equilytic) APP_USER(默认当前用户) PORT(默认 8000)
#   USE_LOCAL_CLAUDE(默认 1，=0 表示用远程 LLM key、不装 shim)
#   CLAUDE_BIN(默认自动探测 `which claude`)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/equilytic}"
APP_USER="${APP_USER:-$(id -un)}"
PORT="${PORT:-8000}"
USE_LOCAL_CLAUDE="${USE_LOCAL_CLAUDE:-1}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*"; }

log "目标：APP_DIR=$APP_DIR  APP_USER=$APP_USER  PORT=$PORT  本地Claude=$USE_LOCAL_CLAUDE"

# 1. 系统依赖
log "安装系统依赖（apt）"
sudo apt-get update -y
sudo apt-get install -y python3.11 python3.11-venv python3-pip git curl wkhtmltopdf

# 2. bun（前端构建）
if ! command -v bun >/dev/null 2>&1; then
  log "安装 bun"
  curl -fsSL https://bun.sh/install | bash
fi
BUN="$HOME/.bun/bin/bun"; command -v bun >/dev/null 2>&1 && BUN="$(command -v bun)"

# 3. 本地 Claude CLI（可选）
if [ "$USE_LOCAL_CLAUDE" = "1" ]; then
  if ! command -v node >/dev/null 2>&1; then
    log "安装 Node 20（claude CLI 依赖）"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  command -v claude >/dev/null 2>&1 || { log "安装 claude CLI"; sudo npm i -g @anthropic-ai/claude-code; }
fi
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo /usr/bin/claude)}"

# 4. 代码就位（脚本若不在 APP_DIR 内，则同步过去）
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  log "同步代码到 $APP_DIR"
  sudo mkdir -p "$APP_DIR"
  sudo chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
  rsync -a --delete --exclude '.git' --exclude '.venv' --exclude 'data' \
    --exclude 'logs' --exclude 'reports' --exclude 'web/node_modules' --exclude 'web/dist' \
    "$SRC_DIR"/ "$APP_DIR"/
else
  sudo chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
fi
cd "$APP_DIR"

# 5. Python venv + 依赖
log "创建 venv 并安装 Python 依赖"
[ -d .venv ] || python3.11 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements.txt

# 6. 构建前端（产物 web/dist，后端自动托管）
log "构建前端（bun）"
( cd web && "$BUN" install && "$BUN" run build )

# 7. 安装 systemd 服务（按变量替换 User/路径/端口/claude）
log "安装 systemd 服务"
render() {  # render <模板> <目标>
  sudo sed \
    -e "s|/opt/equilytic|$APP_DIR|g" \
    -e "s|^User=.*|User=$APP_USER|" \
    -e "s|--port 8000|--port $PORT|" \
    -e "s|CLAUDE_SHIM_CLAUDE_BIN=.*|CLAUDE_SHIM_CLAUDE_BIN=$CLAUDE_BIN|" \
    "$1" | sudo tee "$2" >/dev/null
}
ENABLE_LIST="equilytic"
if [ "$USE_LOCAL_CLAUDE" = "1" ]; then
  render scripts/deploy/equilytic-shim.service /etc/systemd/system/equilytic-shim.service
  ENABLE_LIST="equilytic-shim equilytic"
else
  # 不用本地 Claude：去掉对 shim 的依赖
  sudo sed -e "/equilytic-shim/d" scripts/deploy/equilytic.service > /tmp/equilytic.service
  warn "USE_LOCAL_CLAUDE=0：已移除对 equilytic-shim 的依赖，请确保 .env 配好远程 LLM key"
fi
if [ "$USE_LOCAL_CLAUDE" = "1" ]; then
  render scripts/deploy/equilytic.service /etc/systemd/system/equilytic.service
else
  render /tmp/equilytic.service /etc/systemd/system/equilytic.service
fi
sudo systemctl daemon-reload
sudo systemctl enable $ENABLE_LIST

log "✅ 自动化部分完成。下面 3 步需你手动："
cat <<EOF

  1) 写密钥配置（不进 git）：
       \$EDITOR $APP_DIR/.env
     至少：TUSHARE_TOKEN / FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_STREAM_ENABLED=true
           AGENT_MODE=true / AGENT_NL_ROUTING=true / XUEQIU_COOKIE（可选）
$( [ "$USE_LOCAL_CLAUDE" = "1" ] && echo "
  2) 以运行账号登录 Claude（凭证存在该账号家目录）：
       sudo -u $APP_USER $CLAUDE_BIN login      # 或在该服务里配 ANTHROPIC_API_KEY
       sudo -u $APP_USER $CLAUDE_BIN -p ping --output-format text   # 验证" )

  3) 云控制台安全组放行入站 TCP $PORT（来源建议限你的 IP）。

  完成后启动：
       sudo systemctl start $ENABLE_LIST
       systemctl status equilytic --no-pager
       journalctl -u equilytic -f       # 看到 [Feishu Stream] 客户端已启动 即正常
       curl -s http://127.0.0.1:$PORT/api/health

  ⚠️ 上线后停掉本地那个飞书机器人，别和服务器抢同一个长连接。
EOF

#!/usr/bin/env bash
# =====================================================================
# SuperServerChan 裸 Linux 一键部署脚本
#
# 用法（在已上传项目文件的目录中，以 root 运行）：
#   sudo bash deploy.sh install    首次安装并启动（默认）
#   sudo bash deploy.sh update     更新代码并重启（数据与配置保留）
#   sudo bash deploy.sh status     查看服务状态与健康检查
#   sudo bash deploy.sh uninstall  卸载服务（数据目录 /etc 环境文件保留）
#
# 行为：
#   - 自动安装 Bun（固定版本）与专用系统用户 ssc
#   - 数据目录 /var/lib/superserverchan（SQLite/凭据/主密钥，请纳入备份）
#   - 首次安装自动生成 SSC_ADMIN_TOKEN 与 SSC_SECRET 写入 /etc/superserverchan.env
#   - systemd 服务 ssc.service：开机自启、崩溃自动重启
# =====================================================================
set -euo pipefail

APP="superserverchan"
INSTALL_DIR="/opt/superserverchan"
DATA_DIR="/var/lib/superserverchan"
ENV_FILE="/etc/superserverchan.env"
SERVICE="ssc"
RUN_USER="ssc"
BUN_VERSION="1.4.0"
ACTION="${1:-install}"

log()  { echo -e "\033[1;32m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m==> $*\033[0m"; }
die()  { echo "错误: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请以 root/sudo 运行"
[ -f package.json ] || die "请在项目根目录执行（未找到 package.json）"

# ---- Bun 安装与定位 ---------------------------------------------------

find_bun() {
  local c
  for c in "$(command -v bun 2>/dev/null || true)" /root/.bun/bin/bun "$HOME/.bun/bin/bun" /usr/local/bin/bun; do
    if [ -n "$c" ] && [ -x "$c" ]; then BUN_BIN="$c"; return 0; fi
  done
  return 1
}

ensure_bun() {
  if find_bun; then
    log "检测到 Bun: $BUN_BIN ($("$BUN_BIN" --version))"
    return
  fi
  log "安装 Bun v${BUN_VERSION} ..."
  if command_exists curl; then
    curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
  elif command_exists wget; then
    wget -qO- https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
  else
    die "需要 curl 或 wget 下载 Bun"
  fi
  find_bun || die "Bun 安装失败"
  ln -sf "$BUN_BIN" /usr/local/bin/bun
  log "Bun 已就绪: $BUN_BIN"
}

# ---- 系统用户 / 目录 / 环境文件 ---------------------------------------

ensure_user() {
  if ! id "$RUN_USER" &>/dev/null; then
    useradd -r -M -s "$(command -v nologin || echo /bin/false)" -d "$DATA_DIR" "$RUN_USER"
    log "已创建系统用户 $RUN_USER"
  fi
}

ensure_dirs() {
  mkdir -p "$DATA_DIR"
  chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
  chmod 700 "$DATA_DIR"
}

rand_hex() { # $1 = 字节数
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

ensure_env() {
  if [ -f "$ENV_FILE" ]; then
    log "环境文件已存在: $ENV_FILE（保持不变）"
    return
  fi
  cat > "$ENV_FILE" <<EOF
SSC_PORT=8080
SSC_DATA_DIR=$DATA_DIR
SSC_ADMIN_TOKEN=$(rand_hex 24)
SSC_SECRET=$(rand_hex 32)
# SSC_SEAT_LIMIT=5
# SSC_TEXT_CHUNK_LIMIT=3000
# SSC_SEND_RATE_PER_HOUR=60
EOF
  chmod 600 "$ENV_FILE"
  log "已生成 $ENV_FILE（含管理令牌，可用 grep ADMIN_TOKEN 查看）"
}

env_port() { grep -E '^SSC_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo 8080; }

# ---- 代码同步 ---------------------------------------------------------

sync_code() {
  log "同步代码到 $INSTALL_DIR ..."
  mkdir -p "$INSTALL_DIR"
  tar -C . --exclude=./node_modules --exclude=./data --exclude=./.git --exclude=./.env -cf - . | tar -C "$INSTALL_DIR" -xf -
  (cd "$INSTALL_DIR" && "$BUN_BIN" install --frozen-lockfile)
  chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"
}

# ---- systemd ---------------------------------------------------------

write_unit() {
  cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=SuperServerChan gateway (WeChat push + keyword router)
After=network-online.target
Wants=network-online.target

[Service]
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${BUN_BIN} run src/index.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

health_check() {
  local port base
  port="$(env_port)"; base="http://127.0.0.1:${port:-8080}"
  for _ in $(seq 1 20); do
    if curl -sf -m 3 "${base}/healthz" >/dev/null 2>&1; then
      log "健康检查通过: ${base}/healthz"
      return 0
    fi
    sleep 1
  done
  warn "健康检查未通过，请查看: journalctl -u ${SERVICE} -n 50"
  return 1
}

# ---- 动作 ------------------------------------------------------------

case "$ACTION" in
  install)
    ensure_bun
    ensure_user
    ensure_dirs
    ensure_env
    sync_code
    write_unit
    systemctl enable --now "${SERVICE}"
    log "安装完成。管理页: http://<本机IP>:$(env_port)/"
    log "管理令牌: grep ADMIN_TOKEN ${ENV_FILE}"
    warn "请确认防火墙已放行 $(env_port)/tcp；公网部署建议置于反向代理之后。"
    health_check || true
    ;;
  update)
    find_bun || die "未找到 Bun，请先执行 install"
    sync_code
    write_unit
    systemctl restart "${SERVICE}"
    log "更新完成，服务已重启"
    health_check || true
    ;;
  status)
    systemctl status "${SERVICE}" --no-pager || true
    curl -s -m 3 "http://127.0.0.1:$(env_port)/healthz" && echo || warn "健康检查失败"
    ;;
  uninstall)
    systemctl disable --now "${SERVICE}" 2>/dev/null || true
    rm -f "/etc/systemd/system/${SERVICE}.service"
    systemctl daemon-reload
    rm -rf "$INSTALL_DIR"
    log "已卸载服务与程序目录。"
    warn "数据目录 ${DATA_DIR} 与 ${ENV_FILE} 已保留（含绑定凭据与密钥）；确认不再使用可手动删除。"
    ;;
  *)
    die "未知动作: $ACTION（可用: install | update | status | uninstall）"
    ;;
esac

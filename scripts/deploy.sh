#!/usr/bin/env bash
# =====================================================================
# ServerMoe 裸 Linux 一键部署脚本（nvm 风格远程直链安装）
#
# 远程直链安装（README 提供的一行命令，root 下运行）：
#   curl -fsSL https://raw.githubusercontent.com/lbls741/ServerMoe/main/scripts/deploy.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/lbls741/ServerMoe/main/scripts/deploy.sh | sudo bash -s update
#
# 本地（已上传项目文件）运行：
#   sudo bash scripts/deploy.sh install [release|source] [tag]   首次安装（默认交互菜单选择方式）
#   sudo bash scripts/deploy.sh update  [release|source] [tag]   按安装方式更新（数据与配置保留）
#   sudo bash scripts/deploy.sh status                           查看服务状态与健康检查
#   sudo bash scripts/deploy.sh uninstall                        卸载服务（数据目录 /etc 环境文件保留）
#
# 行为：
#   - 先配置环境：安装 Bun（固定版本）、专用系统用户 ssc、数据目录、/etc/servermoe.env
#   - install 未显式指定方式时，出现键盘菜单（↑/↓ + Enter）：
#       从正式版安装：查询 GitHub 最新 Release 并显示版本号，下载随版发布的运行时包
#         （src + 生产依赖，免装依赖）安装，并注入 MOE_VERSION=<tag> 启用更新检测
#       从源码安装：复用原有逻辑——使用当前目录源码（远程执行时自动 git clone）+ bun install
#   - 安装方式记录在 $INSTALL_DIR/.deploy-mode，update 据此走对应更新路径
#   - 数据目录 /var/lib/servermoe（SQLite/凭据/主密钥，请纳入备份）
#   - systemd 服务 ssc.service：开机自启、崩溃自动重启
# =====================================================================
set -euo pipefail

GH_REPO="${MOE_DEPLOY_REPO:-lbls741/ServerMoe}"
RAW_URL="https://raw.githubusercontent.com/${GH_REPO}/main/scripts/deploy.sh"
INSTALL_DIR="${MOE_DEPLOY_INSTALL_DIR:-/opt/servermoe}"
DATA_DIR="${MOE_DEPLOY_DATA_DIR:-/var/lib/servermoe}"
ENV_FILE="${MOE_DEPLOY_ENV_FILE:-/etc/servermoe.env}"
SERVICE="${MOE_DEPLOY_SERVICE:-ssc}"
RUN_USER="${MOE_DEPLOY_USER:-ssc}"
BUN_VERSION="${MOE_DEPLOY_BUN_VERSION:-1.4.0}"
MODE_FILE="${INSTALL_DIR}/.deploy-mode"
VER_FILE="${INSTALL_DIR}/.deploy-version"
ACTION="${1:-install}"

log()  { echo -e "\033[1;32m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m==> $*\033[0m"; }
die()  { echo "错误: $*" >&2; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

# ---- 交互菜单 ---------------------------------------------------------
# 交互输入一律走 /dev/tty：curl | bash 时 stdin 是脚本本身，绝不能读 stdin。

TTY_FD=""
if { exec 3</dev/tty; } 2>/dev/null; then TTY_FD=3; fi

# menu <标题> <选项...>：键盘选择（↑/↓ + Enter，数字直选，q 取消），结果存入全局 MENU_SEL（1-based）
menu() {
  local title="$1"; shift
  local -a opts=("$@")
  local n=$# sel=0 i key esc2
  MENU_SEL=0

  if [ -z "$TTY_FD" ]; then
    if [ -t 0 ]; then
      # 无 /dev/tty 但 stdin 是终端（少数沙箱环境）：退化为数字选择
      echo "$title"
      for i in "${!opts[@]}"; do echo "  $((i + 1)). ${opts[$i]}"; done
      local choice
      read -r -p "请输入序号 [1-${n}]: " choice || die "无法读取输入"
      case "$choice" in
        [1-9]) if [ "$choice" -le "$n" ]; then MENU_SEL=$choice; return 0; fi ;;
      esac
      die "无效选择: $choice"
    fi
    die "当前环境无法交互选择；请使用非交互方式: deploy.sh install release|source"
  fi

  draw_menu() {
    echo "$title"
    for i in "${!opts[@]}"; do
      if [ "$i" -eq "$sel" ]; then
        echo -e "  \033[1;36m❯ ${opts[$i]}\033[0m"
      else
        echo "    ${opts[$i]}"
      fi
    done
    echo "（↑/↓ 移动，Enter 确认，1-${n} 直选，q 退出）"
  }
  redraw() { printf '\033[%dA' $((n + 2)); draw_menu; }

  draw_menu
  while :; do
    IFS="" read -rsn1 -u "$TTY_FD" key || die "无法读取终端输入"
    case "$key" in
      ""|$'\r') break ;;                                   # Enter
      $'\x1b')                                             # 方向键等转义序列
        esc2=""
        read -rsn2 -u "$TTY_FD" esc2 || esc2=""
        case "$esc2" in
          "[A"|"OA") sel=$(( (sel + n - 1) % n )); redraw ;;
          "[B"|"OB") sel=$(( (sel + 1) % n )); redraw ;;
        esac ;;
      [1-9]) if [ "$key" -le "$n" ]; then sel=$((key - 1)); break; fi ;;
      q|Q) die "已取消安装（环境已就绪，可稍后重跑本脚本完成安装）" ;;
    esac
  done
  MENU_SEL=$((sel + 1))
}

# ---- GitHub Release（正式版安装） --------------------------------------

release_asset_url() { # $1 = tag
  echo "https://github.com/${GH_REPO}/releases/download/$1/servermoe-$1-runtime.tar.gz"
}

latest_tag() {
  local tag=""
  if command_exists curl; then
    tag=$(curl -fsSL -m 20 "https://api.github.com/repos/${GH_REPO}/releases/latest" |
      grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  elif command_exists wget; then
    tag=$(wget -qO- -T 20 "https://api.github.com/repos/${GH_REPO}/releases/latest" |
      grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  fi
  # API 限流/不可达时回退 git ls-remote（版本号倒序取第一个；过滤 latest 等非版本 tag）
  if [ -z "$tag" ] && command_exists git; then
    tag=$(git ls-remote --tags --refs --sort=-v:refname "https://github.com/${GH_REPO}.git" 2>/dev/null |
      awk -F/ '{print $NF}' | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)
  fi
  [ -n "$tag" ] || die "无法获取最新 Release（检查网络；或手动指定版本: deploy.sh install release <tag>）"
  echo "$tag"
}

fetch_url() { # $1 = url, $2 = 输出文件
  if command_exists curl; then
    curl -fL --retry 3 -o "$2" "$1" || die "下载失败: $1"
  elif command_exists wget; then
    wget -qO "$2" "$1" || die "下载失败: $1"
  else
    die "需要 curl 或 wget 下载文件"
  fi
}

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
MOE_PORT=8080
MOE_DATA_DIR=$DATA_DIR
MOE_ADMIN_TOKEN=$(rand_hex 24)
MOE_SECRET=$(rand_hex 32)
# MOE_SEAT_LIMIT=5
# MOE_TEXT_CHUNK_LIMIT=3000
# MOE_SEND_RATE_PER_HOUR=60
EOF
  chmod 600 "$ENV_FILE"
  log "已生成 $ENV_FILE（含管理令牌，可用 grep ADMIN_TOKEN 查看）"
}

set_env_kv() { # $1 = key, $2 = value（更新已有行或追加）
  touch "$ENV_FILE"
  if grep -qE "^${1}=" "$ENV_FILE"; then
    sed -i "s|^${1}=.*|${1}=${2}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

del_env_key() { # $1 = key（源码安装为自构建版，须移除版本号以跳过更新检测）
  if [ -f "$ENV_FILE" ] && grep -qE "^${1}=" "$ENV_FILE"; then
    sed -i "/^${1}=/d" "$ENV_FILE"
    log "已从 $ENV_FILE 移除 ${1}（源码安装视为自构建版，跳过更新检测）"
  fi
}

env_port() { grep -E '^MOE_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo 8080; }

# ---- 代码同步 / 源码解析（源码安装路径） -------------------------------

resolve_source_dir() {
  local d dir
  # 优先当前目录，其次脚本所在目录的上级（含已安装的 /opt/servermoe）
  for d in "$PWD" "$(dirname "${BASH_SOURCE[0]:-$0}")/.."; do
    dir="$(cd "$d" 2>/dev/null && pwd)" || continue
    if [ -f "$dir/package.json" ] && [ -d "$dir/src" ]; then
      echo "$dir"
      return 0
    fi
  done
  command_exists git || die "未找到本地源码且无 git；请把项目目录上传到服务器后重跑，或先安装 git"
  log "未检测到本地源码，从 GitHub 浅克隆 ${GH_REPO} ..."
  local tmp
  tmp="$(mktemp -d)"
  git clone --depth 1 "https://github.com/${GH_REPO}.git" "${tmp}/servermoe" >&2 || die "git clone 失败"
  echo "${tmp}/servermoe"
}

sync_code() { # $1 = 源码目录
  local src="$1"
  log "同步代码 ${src} → ${INSTALL_DIR} ..."
  mkdir -p "$INSTALL_DIR"
  tar -C "$src" --exclude=./node_modules --exclude=./data --exclude=./.git --exclude=./.env --exclude=./dist -cf - . |
    tar -C "$INSTALL_DIR" -xf -
  (cd "$INSTALL_DIR" && "$BUN_BIN" install --frozen-lockfile)
  chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"
}

install_source() {
  local src
  src="$(resolve_source_dir)"
  sync_code "$src"
  case "$src" in /tmp/*) rm -rf "$src" ;; esac
  del_env_key "MOE_VERSION"
  echo "source" > "$MODE_FILE"
  rm -f "$VER_FILE"
  chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"
}

# ---- 正式版安装 -------------------------------------------------------

install_release() { # $1 = tag（可空 = 最新正式版）
  local tag="${1:-$(latest_tag)}"
  local url
  url="$(release_asset_url "$tag")"
  log "最新正式版: ${tag}"
  log "下载运行时包: ${url}"
  local tmp
  tmp="$(mktemp -d)"
  fetch_url "$url" "${tmp}/pkg.tar.gz"
  log "解压安装到 ${INSTALL_DIR} ..."
  systemctl stop "${SERVICE}" 2>/dev/null || true
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "${tmp}/pkg.tar.gz" -C "$INSTALL_DIR" --strip-components=1
  rm -rf "$tmp"
  set_env_kv "MOE_VERSION" "$tag"
  echo "release" > "$MODE_FILE"
  echo "$tag" > "$VER_FILE"
  chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"
  log "已注入 MOE_VERSION=${tag} → $ENV_FILE（管理页更新检测已启用）"
}

# ---- systemd ---------------------------------------------------------

write_unit() {
  cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=ServerMoe gateway (WeChat push + keyword router)
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

require_root() {
  [ "$(id -u)" -eq 0 ] || die "请以 root 运行，例如: curl -fsSL ${RAW_URL} | sudo bash"
}

finish_install() { # $1 = 模式
  write_unit
  systemctl enable --now "${SERVICE}"
  log "安装完成（${1} 模式）。管理页: http://<本机IP>:$(env_port)/"
  if [ "$1" = "release" ]; then
    log "版本: $(cat "$VER_FILE")"
  fi
  log "管理令牌: grep ADMIN_TOKEN ${ENV_FILE}"
  warn "请确认防火墙已放行 $(env_port)/tcp；公网部署建议置于反向代理之后。"
  health_check || true
}

case "$ACTION" in
  install)
    require_root
    log "配置环境 ..."
    ensure_bun
    ensure_user
    ensure_dirs
    ensure_env
    MODE="${2:-}"
    if [ -z "$MODE" ]; then
      menu "选择安装方式" "从正式版安装" "从源码安装"
      case "$MENU_SEL" in
        1) MODE="release" ;;
        2) MODE="source" ;;
        *) die "未知菜单选择: $MENU_SEL" ;;
      esac
    fi
    case "$MODE" in
      release) install_release "${3:-}" ;;
      source)  install_source ;;
      *) die "未知安装方式: $MODE（可用 release|source）" ;;
    esac
    finish_install "$MODE"
    ;;
  update)
    require_root
    find_bun || die "未找到 Bun，请先执行 install"
    MODE="${2:-$(cat "$MODE_FILE" 2>/dev/null || echo '')}"
    [ -n "$MODE" ] || die "未找到安装记录（$MODE_FILE），请先执行 install"
    case "$MODE" in
      release)
        TAG="${3:-$(latest_tag)}"
        if [ "$TAG" = "$(cat "$VER_FILE" 2>/dev/null || true)" ]; then
          log "已是最新正式版 ${TAG}；强制重装请用: source ${TAG}"
        else
          install_release "$TAG"
          write_unit
          systemctl restart "${SERVICE}"
          log "更新完成，服务已重启"
          health_check || true
        fi
        ;;
      source)
        install_source
        write_unit
        systemctl restart "${SERVICE}"
        log "更新完成，服务已重启"
        health_check || true
        ;;
      *) die "未知安装方式: $MODE（可用 release|source）" ;;
    esac
    ;;
  status)
    require_root
    systemctl status "${SERVICE}" --no-pager || true
    if [ -f "$VER_FILE" ]; then log "当前正式版: $(cat "$VER_FILE")"; fi
    curl -s -m 3 "http://127.0.0.1:$(env_port)/healthz" && echo || warn "健康检查失败"
    ;;
  uninstall)
    require_root
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

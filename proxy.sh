#!/usr/bin/env bash
# all_proxy 服务管理脚本（Git Bash / Windows 适配）
#
# 用法:
#   ./proxy.sh start    后台启动（dist 缺失时自动构建）
#   ./proxy.sh stop     停止（SIGTERM，超时后 SIGKILL）
#   ./proxy.sh status   查看运行状态（PID + /health 探活）
#   ./proxy.sh restart  重启
#   ./proxy.sh logs     跟踪运行日志（Ctrl-C 退出）
#
# 端口/地址可用环境变量覆盖（与 serve 本身一致）:
#   ALL_PROXY_PORT=3877 ALL_PROXY_HOST=127.0.0.1 ./proxy.sh start
set -u

cd "$(dirname "$0")"

PORT="${ALL_PROXY_PORT:-3877}"
HOST="${ALL_PROXY_HOST:-127.0.0.1}"
RUN_DIR="data/run"
PID_FILE="$RUN_DIR/all-proxy.pid"
OUT_LOG="$RUN_DIR/all-proxy.out.log"
HEALTH_URL="http://$HOST:$PORT/health"
STOP_TIMEOUT_SEC=10

mkdir -p "$RUN_DIR"

# ── 工具函数 ──────────────────────────────────────────────

# 进程是否存活（msys pid）。
alive() { kill -0 "$1" 2>/dev/null; }

# 读取 PID 文件；无文件或内容非法时输出空串。
read_pid() {
  [ -f "$PID_FILE" ] || return 0
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  case "$pid" in
    ''|*[!0-9]*) return 0 ;;
    *) printf '%s' "$pid" ;;
  esac
}

# 探活 /health；返回 HTTP 状态码（不可达时为 000）。
health_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL" 2>/dev/null || printf '000'
}

# 占用监听端口的 Windows PID（可能有多个，逐行输出）；无占用时输出空。
port_pids_win() {
  netstat -ano 2>/dev/null | grep -E ":$PORT\b" | grep LISTENING | awk '{print $NF}' | sort -u
}

build_if_needed() {
  if [ ! -f dist/index.js ]; then
    echo "未找到 dist/index.js，先构建（tsc + 复制 WASM）……"
    npm run build && npm run build:assets || { echo "构建失败，中止启动"; return 1; }
  fi
  if [ ! -f dist/providers/qoder-auth-wasm.wasm ]; then
    echo "缺少 Qoder WASM 资产，补复制……"
    npm run build:assets || { echo "资产复制失败，中止启动"; return 1; }
  fi
  if [ ! -f web/dist/index.html ]; then
    echo "提示: web/dist 不存在，管理端页面未构建（API 不受影响）。需要时执行: npm run build:web"
  fi
}

# ── 子命令 ────────────────────────────────────────────────

cmd_start() {
  local pid
  pid="$(read_pid)"
  if [ -n "$pid" ] && alive "$pid"; then
    echo "已在运行 (pid $pid)，端口 $PORT。如需重启请执行: ./proxy.sh restart"
    return 0
  fi
  # PID 文件失效但端口仍被占：多半是上次没停干净或另一实例，不重复启动。
  local wpids
  wpids="$(port_pids_win)"
  if [ -n "$wpids" ]; then
    echo "端口 $PORT 已被占用（Windows pid: $(echo "$wpids" | tr '\n' ' ')），未启动。"
    echo "若是残留实例，可用: ./proxy.sh stop （会按端口兜底清理）"
    return 1
  fi
  rm -f "$PID_FILE"

  build_if_needed || return 1

  echo "后台启动 all_proxy（$HOST:$PORT）……"
  # nohup + disown：脱离会话后台运行；stdout/stderr 追加到运行日志。
  nohup env ALL_PROXY_PORT="$PORT" ALL_PROXY_HOST="$HOST" node dist/index.js >> "$OUT_LOG" 2>&1 &
  pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$PID_FILE"

  # 探活等待：最多 15 秒；/health 返回 200 即就绪。
  local i=0 code
  while [ $i -lt 30 ]; do
    if ! alive "$pid"; then
      echo "启动失败（进程已退出），最近日志："
      tail -n 20 "$OUT_LOG"
      rm -f "$PID_FILE"
      return 1
    fi
    code="$(health_code)"
    if [ "$code" = "200" ]; then
      echo "已就绪 (pid $pid): http://$HOST:$PORT"
      echo "  健康检查: $HEALTH_URL   管理端: http://$HOST:$PORT/   日志: $OUT_LOG"
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  echo "进程在运行 (pid $pid) 但 $HEALTH_URL 未就绪（15 秒内无 200），请查看日志: tail -n 50 $OUT_LOG"
  return 1
}

cmd_stop() {
  local pid
  pid="$(read_pid)"
  if [ -n "$pid" ] && alive "$pid"; then
    echo "停止 pid $pid ……"
    kill "$pid" 2>/dev/null
    local waited=0
    while alive "$pid" && [ "$waited" -lt "$STOP_TIMEOUT_SEC" ]; do
      sleep 1; waited=$((waited + 1))
    done
    if alive "$pid"; then
      echo "优雅退出超时，强制结束……"
      kill -9 "$pid" 2>/dev/null || true
      sleep 1
    fi
    alive "$pid" && echo "警告: pid $pid 仍在运行" || echo "已停止"
  else
    echo "无运行中的记录（PID 文件缺失或进程已退出）"
  fi
  rm -f "$PID_FILE"

  # 兜底：PID 记录没了但端口仍被占（例如上次异常退出留下孤儿进程）。
  local wpids
  wpids="$(port_pids_win)"
  if [ -n "$wpids" ]; then
    echo "端口 $PORT 仍被 Windows 进程占用: $(echo "$wpids" | tr '\n' ' ')，强制结束……"
    local w
    for w in $wpids; do
      taskkill //F //PID "$w" >/dev/null 2>&1 || echo "  taskkill 失败 (pid $w)，请手动处理"
    done
  fi
  return 0
}

cmd_status() {
  local pid code wpids
  pid="$(read_pid)"
  if [ -n "$pid" ] && alive "$pid"; then
    code="$(health_code)"
    if [ "$code" = "200" ]; then
      echo "运行中: pid $pid, http://$HOST:$PORT (/health 200)"
    else
      echo "进程存活 (pid $pid) 但 /health 无响应（code $code），可能正在启动或端口($PORT)与进程不一致"
    fi
  else
    [ -n "$pid" ] && echo "PID 文件存在 (pid $pid) 但进程已退出"
    wpids="$(port_pids_win)"
    if [ -n "$wpids" ]; then
      echo "端口 $PORT 被外部 Windows 进程占用: $(echo "$wpids" | tr '\n' ' ')（可能为本脚本之外启动的实例）"
    else
      echo "已停止"
    fi
  fi
  [ -f "$OUT_LOG" ] && echo "日志: $OUT_LOG（$(wc -l < "$OUT_LOG") 行）"
  return 0
}

cmd_logs() {
  [ -f "$OUT_LOG" ] || { echo "暂无日志: $OUT_LOG"; return 0; }
  tail -n "${1:-100}" -f "$OUT_LOG"
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  restart) cmd_stop; echo; cmd_start ;;
  logs)    shift; cmd_logs "${1:-100}" ;;
  *)
    echo "all_proxy 服务管理脚本"
    echo "用法: ./proxy.sh {start|stop|status|restart|logs [行数]}"
    echo "  start    后台启动（dist 缺失时自动构建）"
    echo "  stop     停止"
    echo "  status   查看运行状态"
    echo "  restart  重启"
    echo "  logs     跟踪运行日志（可带起始行数，默认 100）"
    echo "端口/地址: ALL_PROXY_PORT（默认 3877）、ALL_PROXY_HOST（默认 127.0.0.1）"
    exit 1
    ;;
esac

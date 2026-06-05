#!/usr/bin/env bash
# scripts/deploy.sh — local dev start/stop for equilytic
# Manages: Claude shim (8766), FastAPI backend (default 8000), Vite frontend (5173)
#
# Usage:
#   ./scripts/deploy.sh start   [--no-shim] [--host HOST] [--port PORT]
#   ./scripts/deploy.sh stop    [--force]
#   ./scripts/deploy.sh restart [--no-shim] [--host HOST] [--port PORT]
#   ./scripts/deploy.sh status
#   ./scripts/deploy.sh logs    <shim|backend|frontend>

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RUN_DIR="$REPO_ROOT/.run"
PID_DIR="$RUN_DIR/pids"
LOG_DIR="$RUN_DIR/logs"

SHIM_PORT=8766
FRONTEND_PORT=5173
DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT=8000

SERVICES=(shim backend frontend)

# --- colors (only on tty) ---
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_DIM=""; C_RESET=""
fi

log_info()  { printf '%s\n' "$*"; }
log_ok()    { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
log_warn()  { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
log_error() { printf '%s%s%s\n' "$C_RED"    "$*" "$C_RESET" >&2; }

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

mkdir -p "$PID_DIR" "$LOG_DIR"

# --- helpers ---

resolve_python() {
  if [[ -x "$REPO_ROOT/.venv/bin/python" ]]; then
    printf '%s' "$REPO_ROOT/.venv/bin/python"
  elif [[ -n "${VIRTUAL_ENV:-}" && -x "$VIRTUAL_ENV/bin/python" ]]; then
    printf '%s' "$VIRTUAL_ENV/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    command -v python3
  else
    log_error "python3 not found (tried .venv, \$VIRTUAL_ENV, PATH)"
    return 1
  fi
}

# port_in_use PORT -> 0 if in use, 1 otherwise
port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

# wait_for_port HOST PORT TIMEOUT_SECS
wait_for_port() {
  local host="$1" port="$2" timeout="$3"
  local elapsed=0
  while (( elapsed < timeout )); do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

# wait_for_http URL TIMEOUT_SECS
wait_for_http() {
  local url="$1" timeout="$2"
  local elapsed=0
  while (( elapsed < timeout )); do
    if curl -fs -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

pid_file() { printf '%s/%s.pid' "$PID_DIR" "$1"; }
log_file() { printf '%s/%s.log' "$LOG_DIR" "$1"; }

read_pid() {
  local svc="$1" f
  f="$(pid_file "$svc")"
  [[ -f "$f" ]] && cat "$f" || true
}

write_pid() { echo "$2" > "$(pid_file "$1")"; }
clear_pid() { rm -f "$(pid_file "$1")"; }

# pid_alive PID -> 0 if alive
pid_alive() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }

# --- stop ---

# stop_one SVC -> prints status line, returns 0
stop_one() {
  local svc="$1" pid
  pid="$(read_pid "$svc")"

  if [[ -z "$pid" ]]; then
    log_info "$(printf '%-9s %s' "$svc" "not running")"
    return 0
  fi

  if ! pid_alive "$pid"; then
    clear_pid "$svc"
    log_info "$(printf '%-9s %s' "$svc" "not running (stale pid)")"
    return 0
  fi

  # frontend: bun parent, vite child — take down children first
  if [[ "$svc" == "frontend" ]]; then
    pkill -TERM -P "$pid" 2>/dev/null || true
  fi
  kill -TERM "$pid" 2>/dev/null || true

  local waited=0
  while (( waited < 5 )) && pid_alive "$pid"; do
    sleep 1
    waited=$((waited + 1))
  done

  if pid_alive "$pid"; then
    if [[ "$svc" == "frontend" ]]; then
      pkill -KILL -P "$pid" 2>/dev/null || true
    fi
    kill -KILL "$pid" 2>/dev/null || true
    clear_pid "$svc"
    log_warn "$(printf '%-9s %s' "$svc" "force-killed")"
  else
    clear_pid "$svc"
    log_ok "$(printf '%-9s %s' "$svc" "stopped")"
  fi
}

force_kill_by_port() {
  local ports=("$SHIM_PORT" "$DEFAULT_PORT" "$FRONTEND_PORT")
  local lsof_args=()
  for p in "${ports[@]}"; do
    lsof_args+=("-iTCP:$p")
  done
  local pids
  pids="$(lsof -nP -sTCP:LISTEN -t "${lsof_args[@]}" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
    log_warn "force-killed pids: $(echo $pids | tr '\n' ' ')"
  fi
  rm -f "$PID_DIR"/*.pid
}

cmd_stop() {
  local force=0
  while (( $# > 0 )); do
    case "$1" in
      --force) force=1 ;;
      *) log_error "unknown flag for stop: $1"; return 2 ;;
    esac
    shift
  done

  # reverse order: frontend -> backend -> shim
  stop_one frontend
  stop_one backend
  stop_one shim

  if (( force )); then
    force_kill_by_port
  fi
}

# --- start ---

START_NO_SHIM=0
START_HOST="$DEFAULT_HOST"
START_PORT="$DEFAULT_PORT"

parse_start_flags() {
  while (( $# > 0 )); do
    case "$1" in
      --no-shim) START_NO_SHIM=1 ;;
      --host)    START_HOST="$2"; shift ;;
      --port)    START_PORT="$2"; shift ;;
      *) log_error "unknown flag for start: $1"; return 2 ;;
    esac
    shift
  done
}

preflight() {
  local missing=0
  for f in main.py web/package.json scripts/claude_openai_shim.py; do
    if [[ ! -f "$REPO_ROOT/$f" ]]; then
      log_error "missing required file: $f"
      missing=1
    fi
  done
  command -v bun  >/dev/null 2>&1 || { log_error "bun not found in PATH";  missing=1; }
  command -v lsof >/dev/null 2>&1 || { log_error "lsof not found in PATH"; missing=1; }
  command -v curl >/dev/null 2>&1 || { log_error "curl not found in PATH"; missing=1; }
  (( missing == 0 )) || return 1

  local ports=()
  (( START_NO_SHIM )) || ports+=("$SHIM_PORT")
  ports+=("$START_PORT" "$FRONTEND_PORT")
  for p in "${ports[@]}"; do
    if port_in_use "$p"; then
      log_error "port $p already in use — run \`./scripts/deploy.sh stop\` first, or pass --force"
      return 1
    fi
  done
}

start_shim() {
  local py="$1"
  log_info "starting shim on :$SHIM_PORT ..."
  nohup "$py" "$REPO_ROOT/scripts/claude_openai_shim.py" \
    > "$(log_file shim)" 2>&1 &
  write_pid shim "$!"
  if ! wait_for_port "$DEFAULT_HOST" "$SHIM_PORT" 10; then
    log_error "shim failed to start within 10s (see $(log_file shim))"
    return 1
  fi
}

start_backend() {
  local py="$1"
  log_info "starting backend on $START_HOST:$START_PORT ..."
  nohup "$py" "$REPO_ROOT/main.py" --serve-only --host "$START_HOST" --port "$START_PORT" \
    > "$(log_file backend)" 2>&1 &
  write_pid backend "$!"
  if ! wait_for_http "http://$START_HOST:$START_PORT/docs" 15; then
    log_error "backend failed to respond at /docs within 15s (see $(log_file backend))"
    return 1
  fi
}

start_frontend() {
  log_info "starting frontend on :$FRONTEND_PORT ..."
  pushd "$REPO_ROOT/web" > /dev/null
  nohup bun run dev > "$(log_file frontend)" 2>&1 &
  local fpid=$!
  popd > /dev/null
  write_pid frontend "$fpid"
  # Use port listen check rather than HTTP: vite default-binds localhost which on
  # macOS may resolve to ::1 only, while curl 127.0.0.1 forces IPv4.
  if ! wait_for_port "" "$FRONTEND_PORT" 30; then
    log_error "frontend failed to listen on :$FRONTEND_PORT within 30s (see $(log_file frontend))"
    return 1
  fi
}

print_running_summary() {
  printf '\n'
  log_ok "$(printf '%-9s %-9s %-22s %s' SERVICE STATUS LISTEN LOG)"
  if (( START_NO_SHIM == 0 )); then
    log_ok "$(printf '%-9s %-9s %-22s %s' shim     running  "127.0.0.1:$SHIM_PORT" "$(log_file shim)")"
  else
    log_info "$(printf '%-9s %-9s %-22s %s' shim     skipped  "-"                    "-")"
  fi
  log_ok "$(printf '%-9s %-9s %-22s %s' backend  running  "$START_HOST:$START_PORT"    "$(log_file backend)")"
  log_ok "$(printf '%-9s %-9s %-22s %s' frontend running  "127.0.0.1:$FRONTEND_PORT"   "$(log_file frontend)")"
}

cmd_start() {
  parse_start_flags "$@"
  preflight

  local py
  py="$(resolve_python)"
  log_info "using python: $py"

  if (( START_NO_SHIM == 0 )); then
    if ! start_shim "$py"; then
      stop_one shim
      return 1
    fi
  fi

  if ! start_backend "$py"; then
    stop_one backend
    (( START_NO_SHIM )) || stop_one shim
    return 1
  fi

  if ! start_frontend; then
    stop_one frontend
    stop_one backend
    (( START_NO_SHIM )) || stop_one shim
    return 1
  fi

  print_running_summary
}

# --- restart ---

cmd_restart() {
  cmd_stop
  # small grace for ports to free up
  sleep 1
  cmd_start "$@"
}

# --- status ---

# status_one SVC PORT -> prints one row
status_one() {
  local svc="$1" port="$2"
  local pid status pid_display="-"
  pid="$(read_pid "$svc")"

  if [[ -z "$pid" ]]; then
    status="stopped"
  elif ! pid_alive "$pid"; then
    status="stale"
    pid_display="$pid"
  elif ! port_in_use "$port"; then
    status="starting?"
    pid_display="$pid"
  else
    status="running"
    pid_display="$pid"
  fi

  case "$status" in
    running) printf '%s%-9s %-10s %-7s %-6s %s%s\n' "$C_GREEN"  "$svc" "$status" "$pid_display" "$port" "$(log_file "$svc")" "$C_RESET" ;;
    stale)   printf '%s%-9s %-10s %-7s %-6s %s%s\n' "$C_YELLOW" "$svc" "$status" "$pid_display" "$port" "$(log_file "$svc")" "$C_RESET" ;;
    *)       printf '%-9s %-10s %-7s %-6s %s\n'                  "$svc" "$status" "$pid_display" "$port" "$(log_file "$svc")" ;;
  esac
}

cmd_status() {
  printf '%-9s %-10s %-7s %-6s %s\n' SERVICE STATUS PID PORT LOG
  status_one shim     "$SHIM_PORT"
  status_one backend  "$DEFAULT_PORT"
  status_one frontend "$FRONTEND_PORT"
}

# --- logs ---

cmd_logs() {
  local svc="${1:-}"
  case "$svc" in
    shim|backend|frontend) ;;
    "") log_error "logs requires a service: shim|backend|frontend"; return 2 ;;
    *)  log_error "unknown service: $svc (want shim|backend|frontend)"; return 2 ;;
  esac
  local f
  f="$(log_file "$svc")"
  if [[ ! -f "$f" ]]; then
    log_warn "no log file yet: $f"
    return 0
  fi
  exec tail -f "$f"
}

# --- main ---

main() {
  if (( $# == 0 )); then
    usage
    exit 2
  fi
  local cmd="$1"; shift
  case "$cmd" in
    start)   cmd_start   "$@" ;;
    stop)    cmd_stop    "$@" ;;
    restart) cmd_restart "$@" ;;
    status)  cmd_status  "$@" ;;
    logs)    cmd_logs    "$@" ;;
    -h|--help|help) usage ;;
    *) log_error "unknown subcommand: $cmd"; usage; exit 2 ;;
  esac
}

main "$@"

#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

num_or_zero() {
  value=$(printf '%s' "$1" | tr -cd '0-9.')
  if [ -n "$value" ]; then
    printf '%s' "$value"
  else
    printf '0'
  fi
}

cleanup() {
  rm -f "$PROC_BEFORE_FILE" "$PROC_AFTER_FILE" "$MEM_FILE" "$CACHE_TMP_FILE" 2>/dev/null
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

PATH=/opt/sbin:/opt/bin:/opt/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PROC_BEFORE_FILE="/opt/tmp/router-system-health-proc-before-$$.txt"
PROC_AFTER_FILE="/opt/tmp/router-system-health-proc-after-$$.txt"
MEM_FILE="/opt/tmp/router-system-health-mem-$$.txt"
CACHE_FILE="/opt/tmp/router-system-health-cache.json"
CACHE_TMP_FILE="/opt/tmp/router-system-health-cache-$$.json"
CACHE_TTL="${ROUTER_SYSTEM_HEALTH_CACHE_TTL:-20}"

mkdir -p /opt/tmp

now_ts=$(date +%s 2>/dev/null || printf '0')
cache_ts=$(date -r "$CACHE_FILE" +%s 2>/dev/null || printf '0')
cache_age=$((now_ts - cache_ts))
if [ -s "$CACHE_FILE" ] && [ "$cache_age" -ge 0 ] 2>/dev/null && [ "$cache_age" -lt "$CACHE_TTL" ] 2>/dev/null; then
  cat "$CACHE_FILE"
  exit 0
fi

read_cpu_stat() {
  awk '
  $1 == "cpu" {
    for (i = 2; i <= 11; i++) {
      printf "%s%s", ($i + 0), (i == 11 ? "\n" : " ")
    }
    exit
  }
  ' /proc/stat 2>/dev/null
}

read_firmware_cpu() {
  command -v ndmc >/dev/null 2>&1 || return
  ndmc -c "show system" 2>/dev/null | awk -F: '
  $1 ~ /cpuload/ {
    value = $2
    gsub(/[^0-9.]/, "", value)
    if (value != "") {
      print value
      exit
    }
  }
  '
}

clamp_cpu_percent() {
  awk -v value="${1:-0}" 'BEGIN {
    value += 0
    if (value < 0) {
      value = 0
    }
    if (value > 100) {
      value = 100
    }
    printf "%.1f", value
  }'
}

write_pid_ticks() {
  label="$1"
  pid="$2"

  case "$pid" in
    ''|*[!0-9]*)
      return
      ;;
  esac

  stat_line=$(cat "/proc/$pid/stat" 2>/dev/null) || return
  after_paren=${stat_line##*) }
  set -- $after_paren
  ticks=$(( ${12:-0} + ${13:-0} )) 2>/dev/null || ticks=0
  printf '%s %s\n' "$label" "$ticks" >> "$out_file"
}

write_process_ticks() {
  out_file="$1"
  : > "$out_file"

  for pid in $(pidof ndm 2>/dev/null); do
    write_pid_ticks "ndm" "$pid"
  done
  for pid in $(pidof sing-box 2>/dev/null); do
    write_pid_ticks "singbox" "$pid"
  done
  for pid in $(pidof xray 2>/dev/null); do
    write_pid_ticks "xray" "$pid"
  done
  for pid in $(pidof hev-socks5-tunnel hev-socks5-tun 2>/dev/null); do
    write_pid_ticks "proxy" "$pid"
  done
}

grep -E 'MemTotal|MemAvailable' /proc/meminfo > "$MEM_FILE" 2>/dev/null || true

load_one=$(awk '{ print $1 }' /proc/loadavg 2>/dev/null)
load_five=$(awk '{ print $2 }' /proc/loadavg 2>/dev/null)
load_fifteen=$(awk '{ print $3 }' /proc/loadavg 2>/dev/null)
load_running=$(awk '{ print $4 }' /proc/loadavg 2>/dev/null)
cpu_cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)
[ "${cpu_cores:-0}" -gt 0 ] 2>/dev/null || cpu_cores=1
load_one_percent=$(awk -v load="${load_one:-0}" -v cores="${cpu_cores:-1}" 'BEGIN { if (cores > 0) printf "%.1f", (load * 100) / cores; else printf "0" }')
load_five_percent=$(awk -v load="${load_five:-0}" -v cores="${cpu_cores:-1}" 'BEGIN { if (cores > 0) printf "%.1f", (load * 100) / cores; else printf "0" }')
load_fifteen_percent=$(awk -v load="${load_fifteen:-0}" -v cores="${cpu_cores:-1}" 'BEGIN { if (cores > 0) printf "%.1f", (load * 100) / cores; else printf "0" }')

firmware_cpu=$(read_firmware_cpu)
cpu_source="proc"
cpu_user=0
cpu_system=0
cpu_idle=100
cpu_softirq=0
cpu_busy=0
cpu_total_delta=0
processes_measured=false
ndm_cpu=0
singbox_cpu=0
xray_cpu=0
proxy_cpu=0

if [ -n "$firmware_cpu" ]; then
  cpu_source="keenetic"
  cpu_busy=$(clamp_cpu_percent "$firmware_cpu")
  cpu_idle=$(awk -v busy="${cpu_busy:-0}" 'BEGIN { printf "%.1f", 100 - busy }')
else
  write_process_ticks "$PROC_BEFORE_FILE"
  CPU_STAT_BEFORE=$(read_cpu_stat)
  sleep 1
  CPU_STAT_AFTER=$(read_cpu_stat)
  write_process_ticks "$PROC_AFTER_FILE"
  processes_measured=true

  cpu_metrics=$(awk -v before="$CPU_STAT_BEFORE" -v after="$CPU_STAT_AFTER" '
BEGIN {
  split(before, a, " ")
  split(after, b, " ")
  total = 0
  for (i = 1; i <= 10; i++) {
    delta[i] = b[i] - a[i]
    if (delta[i] < 0) {
      delta[i] = 0
    }
    total += delta[i]
  }
  if (total <= 0) {
    printf "0 0 100 0"
    exit
  }
  user = delta[1] + delta[2]
  sys_cpu = delta[3]
  idle = delta[4] + delta[5]
  softirq = delta[6] + delta[7]
  printf "%.1f %.1f %.1f %.1f %d", (user * 100) / total, (sys_cpu * 100) / total, (idle * 100) / total, (softirq * 100) / total, total
}
')
  set -- $cpu_metrics
  cpu_user="${1:-0}"
  cpu_system="${2:-0}"
  cpu_idle="${3:-100}"
  cpu_softirq="${4:-0}"
  cpu_total_delta="${5:-0}"
  cpu_busy=$(awk -v idle="${cpu_idle:-100}" 'BEGIN { printf "%.1f", 100 - idle }')
fi

mem_total_kb=$(awk '/MemTotal:/ { print $2; exit }' "$MEM_FILE" 2>/dev/null)
mem_available_kb=$(awk '/MemAvailable:/ { print $2; exit }' "$MEM_FILE" 2>/dev/null)
mem_used_kb=$(awk -v total="${mem_total_kb:-0}" -v available="${mem_available_kb:-0}" 'BEGIN { print total - available }')
mem_used_percent=$(awk -v total="${mem_total_kb:-0}" -v used="${mem_used_kb:-0}" 'BEGIN { if (total > 0) printf "%.1f", (used * 100) / total; else printf "0" }')

if [ "$processes_measured" = "true" ]; then
  process_metrics=$(awk -v total="${cpu_total_delta:-0}" '
FNR == NR {
  before[$1] += $2
  next
}
{
  after[$1] += $2
}
END {
  labels[1] = "ndm"
  labels[2] = "singbox"
  labels[3] = "xray"
  labels[4] = "proxy"
  for (i = 1; i <= 4; i++) {
    label = labels[i]
    delta = after[label] - before[label]
    if (delta < 0) {
      delta = 0
    }
    value = 0
    if (total > 0) {
      value = (delta * 100) / total
    }
    printf "%.1f%s", value, (i == 4 ? "" : " ")
  }
}
' "$PROC_BEFORE_FILE" "$PROC_AFTER_FILE" 2>/dev/null)
  set -- $process_metrics
  ndm_cpu="${1:-0}"
  singbox_cpu="${2:-0}"
  xray_cpu="${3:-0}"
  proxy_cpu="${4:-0}"
fi

{
  printf '{'
  printf '"ok":true,'
  printf '"sampledAt":"%s",' "$(json_escape "$(date '+%Y-%m-%d %H:%M:%S %z' 2>/dev/null)")"
  printf '"load":{"one":%s,"five":%s,"fifteen":%s,"onePercent":%s,"fivePercent":%s,"fifteenPercent":%s,"cores":%s,"running":"%s"},' \
    "$(num_or_zero "$load_one")" \
    "$(num_or_zero "$load_five")" \
    "$(num_or_zero "$load_fifteen")" \
    "$(num_or_zero "$load_one_percent")" \
    "$(num_or_zero "$load_five_percent")" \
    "$(num_or_zero "$load_fifteen_percent")" \
    "$(num_or_zero "$cpu_cores")" \
    "$(json_escape "$load_running")"
  printf '"cpu":{"user":%s,"system":%s,"idle":%s,"softirq":%s,"busy":%s,"source":"%s"},' \
    "$(num_or_zero "$cpu_user")" \
    "$(num_or_zero "$cpu_system")" \
    "$(num_or_zero "$cpu_idle")" \
    "$(num_or_zero "$cpu_softirq")" \
    "$(num_or_zero "$cpu_busy")" \
    "$(json_escape "$cpu_source")"
  printf '"memory":{"totalKb":%s,"availableKb":%s,"usedKb":%s,"usedPercent":%s},' \
    "$(num_or_zero "$mem_total_kb")" \
    "$(num_or_zero "$mem_available_kb")" \
    "$(num_or_zero "$mem_used_kb")" \
    "$(num_or_zero "$mem_used_percent")"
  printf '"processes":{"ndmCpu":%s,"singboxCpu":%s,"xrayCpu":%s,"proxyCpu":%s,"measured":%s}' \
    "$(num_or_zero "$ndm_cpu")" \
    "$(num_or_zero "$singbox_cpu")" \
    "$(num_or_zero "$xray_cpu")" \
    "$(num_or_zero "$proxy_cpu")" \
    "$processes_measured"
  printf '}'
} > "$CACHE_TMP_FILE"

cat "$CACHE_TMP_FILE"
mv "$CACHE_TMP_FILE" "$CACHE_FILE" 2>/dev/null || true

cleanup

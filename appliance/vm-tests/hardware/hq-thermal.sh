#!/bin/sh
# HQ-06 Thermals: sustained load in the intended enclosure/ambient for ${1:-3600} s, sampling sensors.
. "$(dirname "$0")/lib.sh"
dur=${1:-3600}
baseline
( while :; do date -u +%FT%TZ; cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | tr '\n' ' '; echo; sleep 10; done ) > "$HQ_OUT/thermal.log" &
sampler=$!
say "load for $dur s"
end=$(( $(date +%s) + dur ))
for _ in $(seq "$(nproc)"); do ( while [ "$(date +%s)" -lt $end ]; do :; done ) & done
wait_until=$end; while [ "$(date +%s)" -lt $wait_until ]; do sleep 30; done
kill $sampler 2>/dev/null || true
capture throttle journalctl -k -b --no-pager -g 'throttl|thermal'
result INCONCLUSIVE "operator checks peak temperatures and throttling events against limits"

#!/bin/sh
# HQ-05 Storage: health counters, TRIM through dm-crypt, write-cache flush behaviour, ENOSPC.
. "$(dirname "$0")/lib.sh"
baseline
capture nvme sh -c 'for d in /dev/nvme[0-9]; do nvme smart-log "$d"; done'
capture smart sh -c 'for d in /dev/sd[a-z]; do smartctl -a "$d"; done'
capture trim fstrim -v /persist
capture wcache sh -c 'for d in /sys/block/*/queue/write_cache; do echo "$d: $(cat $d)"; done'
capture df df -h / /persist /boot
result INCONCLUSIVE "operator reviews media wear, TRIM support and write-cache mode against the part's datasheet"

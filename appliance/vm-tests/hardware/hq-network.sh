#!/bin/sh
# HQ-07 Network: link flap, DHCP loss, IPv6-only and captive upstream behaviour; outbound allowlist.
. "$(dirname "$0")/lib.sh"
baseline
capture links networkctl status --no-pager
capture nft nft list table inet whombat-egress
capture listen ss -Htlnu
say "operator: unplug cable 60 s, replug; stop the DHCP server; switch to an IPv6-only network; record"
result INCONCLUSIVE "operator records relay reconnect time and that no inbound port is open (external nmap)"

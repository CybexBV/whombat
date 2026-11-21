#!/bin/sh
# HQ-00 Baseline: record firmware, boot, disk, TPM and watchdog state of a qualification unit.
. "$(dirname "$0")/lib.sh"
baseline
say "baseline captured in $HQ_OUT"
if grep -q 'Secure Boot: enabled (user)' "$HQ_OUT/bootctl.txt"; then result PASS "secure boot enforced"; else result FAIL "secure boot not enforced"; fi
if grep -q 'pcrs=7' "$HQ_OUT/tpm-seal.txt"; then result PASS "tpm slots sealed to PCR 7"; else result FAIL "tpm slots not sealed"; fi
if grep -qi 'timeout' "$HQ_OUT/watchdog.txt"; then result PASS "hardware watchdog present"; else result FAIL "no watchdog device"; fi

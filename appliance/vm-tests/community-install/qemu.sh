#!/usr/bin/env bash
# The community install test's VM (IN-430, NX-445): the community installer ISO in QEMU as install.md §5 sets a VM up
# (q35, OVMF without enrolled keys, no TPM, the i6300esb watchdog), on a blank sparse disk in the agent-resource
# workspace. Run it only under `agent-resource run` (QEMU stays in the managed task's cgroup; the disk and the firmware's
# variables are in $AGENT_RESOURCE_WORKSPACE, removed with it):
#
#   agent-resource run --task "…" --ttl 6h -- vm-tests/community-install/qemu.sh <iso> <state dir>
#
# The disk boots first and the ISO second, so the first boot installs and the reboot after it starts the installed
# system. QEMU's user network: the box is 10.0.2.15 and reaches this machine's 127.0.0.1 ports at 10.0.2.2 (the update
# repository and Headscale the test serves); its direct port 4480 is this machine's 127.0.0.1:$WB_DIRECT_PORT (default
# 47480). <state dir> gets `workspace` (the path), and the workspace `qmp.sock` (screen, keys) and `serial.log`.
set -euo pipefail

iso=${1:?usage: qemu.sh <iso> <state dir>}
state=${2:?usage: qemu.sh <iso> <state dir>}
ws=${AGENT_RESOURCE_WORKSPACE:?run under agent-resource run}
qemu=${WB_QEMU:?WB_QEMU: a qemu (nixpkgs qemu_kvm) store path}
ovmf=${WB_OVMF:?WB_OVMF: OVMF.fd store path (FV/OVMF_CODE.fd, FV/OVMF_VARS.fd)}
port=${WB_DIRECT_PORT:-47480}

cd "$ws"
cp "$ovmf/FV/OVMF_VARS.fd" vars.fd
chmod u+w vars.fd
"$qemu/bin/qemu-img" create -q -f qcow2 disk.qcow2 128G
mkdir -p "$state"
echo "$ws" >"$state/workspace"
echo "qemu: workspace $ws, direct port 127.0.0.1:$port" >&2
exec "$qemu/bin/qemu-system-x86_64" \
  -no-user-config -name whombat-community-install-test -enable-kvm -machine q35 -cpu host -smp 4 -m 6144 \
  -drive if=pflash,format=raw,readonly=on,file="$ovmf/FV/OVMF_CODE.fd" \
  -drive if=pflash,format=raw,file=vars.fd \
  -drive if=none,id=disk0,format=qcow2,file=disk.qcow2,discard=unmap -device virtio-blk-pci,drive=disk0,bootindex=1 \
  -drive if=none,id=cd0,media=cdrom,readonly=on,file="$iso" -device ide-cd,drive=cd0,bootindex=2 \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:"$port"-:4480 -device virtio-net-pci,netdev=n0 \
  -device i6300esb -action watchdog=reset \
  -vga std -display none -qmp unix:qmp.sock,server=on,wait=off -serial file:serial.log \
  -no-shutdown

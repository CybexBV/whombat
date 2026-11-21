/**
 * The seccomp filter of a managed task's payload (docs/decisions/managed-sandbox.md MSB-04): a small classic-BPF
 * denylist, loaded by bubblewrap (`--seccomp <fd>`) after it drops every capability and sets `no_new_privs`.
 * It removes kernel interfaces a coding task never needs and that are the usual way out of a namespace
 * sandbox: the kernel keyring, eBPF, perf events, userfaultfd, io_uring, file handles (`open_by_handle_at`),
 * module and kexec loading, and on x86-64 the whole x32 ABI. Namespaces stay available: the providers' own
 * sandboxes (Claude Code's and Codex's bubblewrap) nest inside this one.
 *
 * Architectures other than the one the filter was built for are killed (a 32-bit syscall entry would bypass
 * a table written for 64-bit numbers).
 */

const AUDIT_ARCH = { x64: 0xc000003e, arm64: 0xc00000b7 } as const;
export type SeccompArch = keyof typeof AUDIT_ARCH;

/** Syscall numbers per architecture (x86-64 from `unistd_64.h`, arm64 from the generic table). */
const SYSCALLS: Record<string, { x64: number; arm64: number }> = {
  add_key: { x64: 248, arm64: 217 },
  request_key: { x64: 249, arm64: 218 },
  keyctl: { x64: 250, arm64: 219 },
  bpf: { x64: 321, arm64: 280 },
  perf_event_open: { x64: 298, arm64: 241 },
  userfaultfd: { x64: 323, arm64: 282 },
  open_by_handle_at: { x64: 304, arm64: 265 },
  kexec_load: { x64: 246, arm64: 104 },
  kexec_file_load: { x64: 320, arm64: 294 },
  init_module: { x64: 175, arm64: 105 },
  finit_module: { x64: 313, arm64: 273 },
  delete_module: { x64: 176, arm64: 106 },
  io_uring_setup: { x64: 425, arm64: 425 },
  io_uring_enter: { x64: 426, arm64: 426 },
  io_uring_register: { x64: 427, arm64: 427 },
  acct: { x64: 163, arm64: 89 },
  swapon: { x64: 167, arm64: 224 },
  swapoff: { x64: 168, arm64: 225 },
  reboot: { x64: 169, arm64: 142 },
  settimeofday: { x64: 164, arm64: 170 },
  clock_settime: { x64: 227, arm64: 112 },
  clock_adjtime: { x64: 305, arm64: 266 },
  adjtimex: { x64: 159, arm64: 171 },
  quotactl: { x64: 179, arm64: 60 },
  lookup_dcookie: { x64: 212, arm64: 18 },
  fanotify_init: { x64: 300, arm64: 262 },
  name_to_handle_at: { x64: 303, arm64: 264 },
  vhangup: { x64: 153, arm64: 58 },
};

/** Denied with ENOSYS (callers fall back: io_uring users go back to epoll), everything else with EPERM. */
const ENOSYS_CALLS = new Set(['io_uring_setup', 'io_uring_enter', 'io_uring_register']);

// Classic BPF opcodes.
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JGE_K = 0x35;
const BPF_RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;
const X32_SYSCALL_BIT = 0x40000000;

export function hostSeccompArch(arch: string = process.arch): SeccompArch | null {
  return arch === 'x64' || arch === 'arm64' ? arch : null;
}

/** The filter as bytes (`struct sock_filter[]`, little-endian), ready for `bwrap --seccomp <fd>`. */
export function seccompFilter(arch: SeccompArch): Buffer {
  type Insn = [code: number, jt: number, jf: number, k: number];
  const denied = Object.entries(SYSCALLS).map(([name, nr]) => ({ name, nr: nr[arch] }));
  const program: Insn[] = [];
  // Wrong architecture: kill.
  program.push([BPF_LD_W_ABS, 0, 0, 4]);
  program.push([BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH[arch]]);
  program.push([BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS]);
  program.push([BPF_LD_W_ABS, 0, 0, 0]);
  if (arch === 'x64') {
    // x32 ABI numbers (bit 30 set): EPERM, whatever the call.
    program.push([BPF_JMP_JGE_K, 0, 1, X32_SYSCALL_BIT]);
    program.push([BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM]);
  }
  for (const { name, nr } of denied) {
    const errno = ENOSYS_CALLS.has(name) ? ENOSYS : EPERM;
    program.push([BPF_JMP_JEQ_K, 0, 1, nr]);
    program.push([BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | errno]);
  }
  program.push([BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW]);
  const buf = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], i) => {
    buf.writeUInt16LE(code, i * 8);
    buf.writeUInt8(jt, i * 8 + 2);
    buf.writeUInt8(jf, i * 8 + 3);
    buf.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return buf;
}

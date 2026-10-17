// SPDX-License-Identifier: GPL-3.0-or-later
// Bounded, process-isolated decoder for installed Unreal version metadata.
#include "stdafx.h"
#include <climits>
#include <cstddef>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>
#include "runtime.h"

int Kraken_Decompress(const byte *, size_t, byte *, size_t);
constexpr size_t MAX_BYTES = 256 * 1024;
// Upstream explicitly requires 64 bytes of destination overrun space.
constexpr size_t SAFE_SPACE = 64;

static bool limit(int resource, rlim_t amount) {
  const rlimit value = {amount, amount};
  return raw_syscall(SYS_prlimit64, 0, resource, reinterpret_cast<long>(&value), 0) == 0;
}

static bool isolate() {
  // The upstream decoder is not fuzz-safe. Confine corruption to this disposable
  // process: no path access, sockets, process creation, execution or device calls.
  const long closed = raw_syscall(SYS_close_range, 3U, UINT_MAX, 0U);
  if (closed == -38) { // ENOSYS on kernels before Linux 5.9.
    rlimit descriptors;
    if (raw_syscall(SYS_prlimit64, 0, RLIMIT_NOFILE, 0, reinterpret_cast<long>(&descriptors)) != 0) return false;
    for (rlim_t fd = 3; fd < descriptors.rlim_cur; ++fd) raw_syscall(SYS_close, fd);
  } else if (closed != 0) return false;
  if (!limit(RLIMIT_CORE, 0) || !limit(RLIMIT_AS, 64 * 1024 * 1024) ||
      !limit(RLIMIT_CPU, 1) || !limit(RLIMIT_NOFILE, 3) ||
      !limit(RLIMIT_NPROC, 0) || !limit(RLIMIT_STACK, 8 * 1024 * 1024)) return false;
  const sock_filter instructions[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_write, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_rt_sigreturn, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_exit_group, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_exit, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
  };
  sock_fprog program = {sizeof(instructions) / sizeof(instructions[0]),
                       const_cast<sock_filter *>(instructions)};
  return raw_syscall(SYS_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 &&
         raw_syscall(SYS_prctl, PR_SET_SECCOMP, SECCOMP_MODE_FILTER, reinterpret_cast<long>(&program), 0, 0) == 0;
}

static int main(int argc, char **argv) {
  if (argc != 2 || !argv[1][0]) return 2;
  size_t expected = 0;
  for (const char *p = argv[1]; *p; ++p) {
    if (*p < '0' || *p > '9' || expected > MAX_BYTES / 10) return 2;
    expected = expected * 10 + (*p - '0');
    if (expected > MAX_BYTES) return 2;
  }
  if (expected == 0) return 2;
  static byte input[MAX_BYTES + SAFE_SPACE + 1];
  static byte output[MAX_BYTES + SAFE_SPACE];
  // Read one extra byte to reject excessive input rather than silently truncate.
  size_t count = 0;
  while (count <= MAX_BYTES) {
    const long n = raw_syscall(SYS_read, 0, reinterpret_cast<long>(input + count), MAX_BYTES + 1 - count);
    if (n == -4) continue; // EINTR
    if (n < 0) return 3;
    if (n == 0) break;
    count += static_cast<size_t>(n);
  }
  if (count < 2 || count > MAX_BYTES) return 3;
  if (!isolate()) return 4;
  const int decoded = Kraken_Decompress(input, count, output, expected);
  if (decoded != static_cast<int>(expected)) return 5;
  size_t offset = 0;
  while (offset < expected) {
    const long written = raw_syscall(SYS_write, 1, reinterpret_cast<long>(output + offset), expected - offset);
    if (written == -4) continue; // EINTR
    if (written <= 0) return 6;
    offset += written;
  }
  return 0;
}

// Linux process entry: no C/C++ runtime, loader, constructors or game execution.
extern "C" [[noreturn]] void cgl_entry(unsigned long *stack) {
  const int result = main(static_cast<int>(stack[0]), reinterpret_cast<char **>(stack + 1));
  raw_syscall(SYS_exit_group, result);
  __builtin_unreachable();
}
asm(".global _start\n"
    "_start:\n"
    "xor %ebp,%ebp\n"
    "mov %rsp,%rdi\n"
    "and $-16,%rsp\n"
    "call cgl_entry\n"
    "ud2\n");

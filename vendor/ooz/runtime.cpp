// SPDX-License-Identifier: GPL-3.0-or-later
// Tiny freestanding support: avoids linking or redistributing libc/libstdc++.
#include <stddef.h>
#include <stdint.h>
#include <sys/syscall.h>
#include "runtime.h"

extern "C" void *malloc(size_t length) {
  alignas(16) static unsigned char arena[2 * 1024 * 1024];
  static size_t used = 0;
  if (length > sizeof(arena) - used - 16) {
    raw_syscall(SYS_exit_group, 7);
    __builtin_unreachable();
  }
  const size_t start = used;
  used += (length + 15) & ~static_cast<size_t>(15);
  return arena + start;
}
extern "C" void free(void *) {}
extern "C" void *memset(void *target, int value, size_t count) {
  auto *out = static_cast<unsigned char *>(target);
  for (size_t i = 0; i < count; ++i) out[i] = static_cast<unsigned char>(value);
  return target;
}
extern "C" void *memcpy(void *target, const void *source, size_t count) {
  auto *out = static_cast<unsigned char *>(target);
  const auto *in = static_cast<const unsigned char *>(source);
  for (size_t i = 0; i < count; ++i) out[i] = in[i];
  return target;
}
extern "C" void *memmove(void *target, const void *source, size_t count) {
  auto *out = static_cast<unsigned char *>(target);
  const auto *in = static_cast<const unsigned char *>(source);
  if (reinterpret_cast<uintptr_t>(target) < reinterpret_cast<uintptr_t>(source)) {
    for (size_t i = 0; i < count; ++i) out[i] = in[i];
  } else {
    for (size_t i = count; i != 0; --i) out[i - 1] = in[i - 1];
  }
  return target;
}

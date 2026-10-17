// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
inline long raw_syscall(long number, long a = 0, long b = 0, long c = 0,
                        long d = 0, long e = 0, long f = 0) {
  register long r10 asm("r10") = d;
  register long r8 asm("r8") = e;
  register long r9 asm("r9") = f;
  long result;
  asm volatile("syscall" : "=a"(result)
               : "a"(number), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8), "r"(r9)
               : "rcx", "r11", "memory");
  return result;
}

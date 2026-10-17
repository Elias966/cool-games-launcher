// SPDX-License-Identifier: GPL-3.0-or-later
// Linux x86_64 adaptation; no third-party runtime library is linked.
#pragma once
#include <string.h>
#include <stdint.h>
#include <assert.h>
#include <stddef.h>
extern "C" void *malloc(size_t);
extern "C" void free(void *);
#include <immintrin.h>
#define __forceinline inline __attribute__((always_inline))
#define _M_X64 1
#define __int64 long long
#define _byteswap_ulong __builtin_bswap32
#define _byteswap_uint64 __builtin_bswap64
#define _byteswap_ushort __builtin_bswap16
inline unsigned char _BitScanForward(unsigned long *index, unsigned long mask) { if(!mask)return 0; *index=__builtin_ctz((uint32_t)mask); return 1; }
inline unsigned char _BitScanReverse(unsigned long *index, unsigned long mask) { if(!mask)return 0; *index=31-__builtin_clz((uint32_t)mask); return 1; }
inline uint64_t _rotr64(uint64_t x,int n) { return (x>>n)|(x<<(64-n)); }
inline uint64_t _umul128(uint64_t a,uint64_t b,uint64_t *hi) { __uint128_t r=(__uint128_t)a*b;*hi=r>>64;return r; }
typedef unsigned char byte;
typedef uint8_t uint8;
typedef uint32_t uint32;
typedef uint64_t uint64;
typedef int64_t int64;
typedef int32_t int32;
typedef uint16_t uint16;
typedef int16_t int16;
typedef unsigned int uint;

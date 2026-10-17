# Isolated Oodle metadata decoder

This directory contains the complete corresponding source for `cgl-ooz`,
including the upstream decoder pinned in `upstream.json`, its full GPLv3
license, the Linux portability header, and our bounded helper entry point.
The upstream decoder is copyright (C) 2016 Powzix and licensed
GPL-3.0-or-later. Local adaptations carry the same license.

Source: https://github.com/powzix/ooz/tree/05038060aa68f9187ae9923b2388ca8db40e58d1

Build from the launcher repository root with `node scripts/build-ooz.mjs`.
This uses a Linux x86_64 C++17 compiler (`g++`, or `CGL_OOZ_CXX`). The helper
is freestanding: it links no libc, libstdc++, libgcc or other runtime library.
Its complete syscall and memory support is provided in `runtime.cpp` and
`runtime.h`. The build checks the pinned upstream
SHA-256 digests and removes only the original Windows command-line interface;
the decoder itself remains unchanged. The build recipe is distributed in
the launcher source repository at `scripts/build-ooz.mjs`. To rebuild directly
from this directory (including the copy distributed inside the AppImage),
run `make` using the included standalone build recipe.

Protocol: run `cgl-ooz EXPECTED_OUTPUT_BYTES`, pipe one Oodle block to stdin,
and read exactly that many uncompressed bytes from stdout. Both input and
output are limited to 256 KiB. No filenames, game identifiers, keys or build
numbers are accepted. Exit status is nonzero on invalid input, unsupported
streams, decoder failure, resource exhaustion or isolation failure. The caller
must impose a wall-clock timeout and a 256 KiB output limit.

The upstream decoder explicitly says it is not fuzz-safe. It executes in a
short-lived helper process with 64 MiB address-space and one CPU-second
limits, no core dumps, no extra inherited descriptors, and a Linux seccomp
allowlist that prevents file, network and process operations during decoding.
A malformed block can terminate the helper; it must never terminate the
launcher or be treated as evidence of a game version.

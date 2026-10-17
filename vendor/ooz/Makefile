# SPDX-License-Identifier: GPL-3.0-or-later
# Complete standalone build recipe for the sources shipped in the AppImage.
CXX ?= g++
CXXFLAGS = -std=c++17 -O2 -DNDEBUG -msse4.1 -fno-strict-aliasing -ffreestanding -fno-exceptions -fno-rtti -fno-stack-protector -U_FORTIFY_SOURCE -fno-pie -no-pie -nostdlib -nodefaultlibs -static -Wl,--build-id=none -Wl,-z,noexecstack -s

cgl-ooz: kraken.cpp bitknit.cpp lzna.cpp stdafx.h main.cpp runtime.cpp runtime.h SHA256SUMS Makefile
	sha256sum --check SHA256SUMS
	@build_dir=$$(mktemp -d); trap 'rm -rf "$$build_dir"' EXIT; \
	  sed '/^\/\/ The decompressor will write outside of the target buffer\./,$$d' kraken.cpp > "$$build_dir/decoder.cpp"; \
	  $(CXX) $(CXXFLAGS) -I . "$$build_dir/decoder.cpp" bitknit.cpp lzna.cpp main.cpp runtime.cpp -o "$$build_dir/cgl-ooz" && \
	  cp "$$build_dir/cgl-ooz" ./cgl-ooz.tmp && chmod 755 ./cgl-ooz.tmp && mv ./cgl-ooz.tmp ./cgl-ooz

.PHONY: clean
clean:
	rm -f cgl-ooz cgl-ooz.tmp

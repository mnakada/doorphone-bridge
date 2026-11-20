# Build a Debian arm64 .deb for doorphone-hap inside a linux/arm64 container,
# so that `npm install` picks the right native prebuilt binaries and the
# resulting package is self-contained (no on-target npm).
#
# Auto-detects the container runtime in order: apple `container`, docker,
# podman. On x86_64 Linux hosts, docker / podman need qemu-user-static
# (binfmt) to run the arm64 image; on Debian/Ubuntu install `qemu-user-static`.
#
# Usage (from the project root):
#   make                 # build the .deb
#   make clean           # wipe stage + dist
#   make image           # build only the container image
#   make deb             # same as `make`
#   RUNTIME=docker make  # force a specific runtime

SHELL        := /bin/bash
ROOT         := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PKG          := $(ROOT)/packaging
PKG_SRC      := $(PKG)/deb
STAGE        := $(PKG)/stage
SCRIPTS      := $(PKG)/scripts-mount
CONTAINEROUT := $(PKG)/.container-out

VERSION      := $(shell grep -E '^Version:' $(PKG_SRC)/DEBIAN/control | awk '{print $$2}')
ARCH         := $(shell grep -E '^Architecture:' $(PKG_SRC)/DEBIAN/control | awk '{print $$2}')
DEB          := $(ROOT)/doorphone-hap_$(VERSION)_$(ARCH).deb
IMAGE_TAG    := doorphone-hap/deb-builder:latest

# Container runtime auto-detection — override with `RUNTIME=docker make`.
RUNTIME      ?= $(firstword $(foreach r,container docker podman,$(if $(shell command -v $(r) 2>/dev/null),$(r))))
ifeq ($(RUNTIME),)
  $(error No container runtime found. Install Apple `container`, docker, or podman.)
endif

# Apple `container` reads FROM --platform natively; docker/podman need the
# flag on build + run to pick the right QEMU interpreter on x86_64 hosts.
ifeq ($(RUNTIME),container)
  PLATFORM_ARG :=
else
  PLATFORM_ARG := --platform linux/arm64
endif

APP_DST      := $(STAGE)/opt/doorphone-hap
PROTO_DST    := $(STAGE)/opt/proto

HAP_SRCS     := accessory.js base-rpc.js config.js creds-refresher.js doorphone-source.js \
                h264-depay.js pair.js pair-web.js pickport.js records.js srtp.js \
                streaming.js package.json package-lock.json

.PHONY: all deb image stage clean

all: deb

$(DEB): image stage
	@echo "== Running build container ($(RUNTIME)) =="
	@rm -rf "$(CONTAINEROUT)" && mkdir -p "$(CONTAINEROUT)"
	$(RUNTIME) run --rm $(PLATFORM_ARG) \
	  -v "$(STAGE):/build/stage" \
	  -v "$(SCRIPTS):/build/scripts" \
	  -v "$(CONTAINEROUT):/build/dist" \
	  $(IMAGE_TAG)
	mv "$(CONTAINEROUT)/package.deb" "$(DEB)"
	rm -rf "$(CONTAINEROUT)"
	@echo
	@echo "Done. Package at: $(DEB)"
	@ls -la "$(DEB)"

deb: $(DEB)

image:
	@echo "== Building container image ($(RUNTIME)) =="
	$(RUNTIME) build $(PLATFORM_ARG) \
	  --tag $(IMAGE_TAG) \
	  --file $(PKG)/Containerfile \
	  $(PKG)

stage:
	@echo "== Preparing stage tree =="
	rm -rf "$(STAGE)" "$(SCRIPTS)"
	mkdir -p "$(STAGE)" "$(APP_DST)" "$(APP_DST)/bin" "$(APP_DST)/web" "$(PROTO_DST)" "$(SCRIPTS)"
	cp -a "$(PKG_SRC)/." "$(STAGE)/"
	@echo "== Copying application sources =="
	$(foreach f,$(HAP_SRCS),cp -a "$(ROOT)/hap/$(f)" "$(APP_DST)/";)
	cp -a "$(ROOT)/hap/bin/doorphone-hap" "$(APP_DST)/bin/"
	cp -a "$(ROOT)/hap/web/." "$(APP_DST)/web/"
	cp -a "$(ROOT)/proto/." "$(PROTO_DST)/"
	cp -a "$(PKG)/do-build.sh" "$(SCRIPTS)/do-build.sh"
	chmod +x "$(SCRIPTS)/do-build.sh"
	@echo "== Syncing package.json version to $(VERSION) =="
	sed -i.bak -E 's/"version"[[:space:]]*:[[:space:]]*"[^"]*"/"version": "$(VERSION)"/' "$(APP_DST)/package.json"
	rm -f "$(APP_DST)/package.json.bak"

clean:
	rm -rf "$(STAGE)" "$(CONTAINEROUT)" "$(SCRIPTS)"
	rm -f "$(ROOT)"/doorphone-hap_*.deb

#!/bin/sh
# Install the pinned IM CLI selected by $IM. npm registry only; nothing is fetched from GitHub.
set -eu

: "${IM:?IM build arg is required (feishu|lark|dingtalk|wecom)}"
: "${CLI_PKG:?CLI_PKG build arg is required}"
: "${CLI_VERSION:?CLI_VERSION build arg is required}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
NPM="npm i -g --no-audit --no-fund --registry=$NPM_REGISTRY"

# node:*-slim has no system CA bundle, and the Go (lark-cli, dws) and Rust (wecom-cli) CLIs need one
# for every HTTPS call. Write Node's bundled Mozilla root store (same source as Debian's
# ca-certificates) instead of an apt step: no network, deterministic per Node version.
mkdir -p /etc/ssl/certs
node -e 'process.stdout.write(require("tls").rootCertificates.join("\n") + "\n")' > /etc/ssl/certs/ca-certificates.crt
test -s /etc/ssl/certs/ca-certificates.crt

case "$IM" in
  feishu|lark)
    # --ignore-scripts: the upstream postinstall needs curl (absent in -slim) and tries GitHub first.
    $NPM --ignore-scripts "$CLI_PKG@$CLI_VERSION"
    LARK_PKG_DIR="$(npm root -g)/$CLI_PKG" node /build/fetch-lark-binary.mjs
    lark-cli --version
    ;;
  dingtalk)
    # The package ships every platform's archive (~130 MB); postinstall extracts the host one.
    DWS_NO_SKILLS=1 $NPM "$CLI_PKG@$CLI_VERSION"
    rm -rf "$(npm root -g)/$CLI_PKG/assets"
    dws --version
    ;;
  wecom)
    : "${CLI_PLATFORM_PKG:?CLI_PLATFORM_PKG build arg is required for wecom}"
    $NPM "$CLI_PKG@$CLI_VERSION" "$CLI_PLATFORM_PKG@$CLI_VERSION"
    wecom-cli --version
    ;;
  *)
    echo "unsupported IM: $IM" >&2
    exit 1
    ;;
esac

npm cache clean --force >/dev/null 2>&1 || true
rm -rf /root/.npm /tmp/* 2>/dev/null || true

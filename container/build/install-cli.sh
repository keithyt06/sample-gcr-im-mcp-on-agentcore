#!/bin/sh
# Install the pinned IM CLI selected by $IM. npm registry only; nothing is fetched from GitHub.
#
# Supply chain (review M-7): every tarball is fetched with `npm pack`, its sha512 is checked against
# /build/cli-integrity.json (npm dist.integrity; identical on npmjs and npmmirror), and it is unpacked
# directly into the global node_modules. No `npm install` runs, so no transitive dependency is resolved.
set -eu

: "${IM:?IM build arg is required (feishu|lark|dingtalk|wecom)}"
: "${CLI_PKG:?CLI_PKG build arg is required}"
: "${CLI_VERSION:?CLI_VERSION build arg is required}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
GLOBAL_NM="$(npm root -g)"
GLOBAL_BIN="$(dirname "$GLOBAL_NM")/../bin"
WORK="$(mktemp -d)"

# node:*-slim has no system CA bundle, and the Go (lark-cli, dws) and Rust (wecom-cli) CLIs need one
# for every HTTPS call. Write Node's bundled Mozilla root store (same source as Debian's
# ca-certificates) instead of an apt step: no network, deterministic per Node version.
mkdir -p /etc/ssl/certs
node -e 'process.stdout.write(require("tls").rootCertificates.join("\n") + "\n")' > /etc/ssl/certs/ca-certificates.crt
test -s /etc/ssl/certs/ca-certificates.crt

# fetch_verified <pkg> <version> -> unpacks into $GLOBAL_NM/<pkg>
fetch_verified() {
  pkg="$1"; ver="$2"
  want="$(node -e 'const j=require("/build/cli-integrity.json"); const v=j[process.argv[1]]; if(!v){console.error("no integrity pin for "+process.argv[1]); process.exit(1)} process.stdout.write(v)' "$pkg@$ver")"
  tgz="$(cd "$WORK" && npm pack --silent --registry="$NPM_REGISTRY" "$pkg@$ver" | tail -n 1)"
  got="sha512-$(node -e 'process.stdout.write(require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "$WORK/$tgz")"
  if [ "$got" != "$want" ]; then
    echo "integrity mismatch for $pkg@$ver: expected $want got $got" >&2
    exit 1
  fi
  echo "verified $pkg@$ver $got"
  rm -rf "$GLOBAL_NM/$pkg"
  mkdir -p "$GLOBAL_NM/$pkg"
  tar -xzf "$WORK/$tgz" -C "$GLOBAL_NM/$pkg" --strip-components=1 --no-same-owner
}

# link_bin <name> <path relative to package dir> <pkg>
link_bin() {
  chmod 755 "$GLOBAL_NM/$3/$2"
  ln -sf "$GLOBAL_NM/$3/$2" "$GLOBAL_BIN/$1"
}

case "$IM" in
  feishu|lark)
    fetch_verified "$CLI_PKG" "$CLI_VERSION"
    # Upstream postinstall needs curl (absent in -slim) and tries GitHub first: fetch the binary ourselves,
    # checked against checksums.txt from the integrity-verified tarball.
    LARK_PKG_DIR="$GLOBAL_NM/$CLI_PKG" node /build/fetch-lark-binary.mjs
    link_bin lark-cli scripts/run.js "$CLI_PKG"
    lark-cli --version
    ;;
  dingtalk)
    fetch_verified "$CLI_PKG" "$CLI_VERSION"
    # The package ships every platform's archive (~130 MB); its postinstall extracts the host one.
    (cd "$GLOBAL_NM/$CLI_PKG" && DWS_NO_SKILLS=1 node install.js)
    rm -rf "$GLOBAL_NM/$CLI_PKG/assets"
    link_bin dws bin/dws.js "$CLI_PKG"
    dws --version
    ;;
  wecom)
    : "${CLI_PLATFORM_PKG:?CLI_PLATFORM_PKG build arg is required for wecom}"
    fetch_verified "$CLI_PKG" "$CLI_VERSION"
    fetch_verified "$CLI_PLATFORM_PKG" "$CLI_VERSION"
    chmod 755 "$GLOBAL_NM/$CLI_PLATFORM_PKG/bin/wecom-cli"
    link_bin wecom-cli bin/wecom.js "$CLI_PKG"
    wecom-cli --version
    ;;
  *)
    echo "unsupported IM: $IM" >&2
    exit 1
    ;;
esac

rm -rf "$WORK"
npm cache clean --force >/dev/null 2>&1 || true
rm -rf /root/.npm /tmp/* 2>/dev/null || true

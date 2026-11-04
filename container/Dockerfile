ARG BASE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${BASE_IMAGE}
ARG IM
ARG CLI_PKG
ARG CLI_VERSION
ARG CLI_PLATFORM_PKG=
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG LARK_BINARY_BASE=https://registry.npmmirror.com/-/binary/lark-cli
ENV NODE_ENV=production NO_UPDATE_NOTIFIER=1 npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
COPY build/ /build/
RUN IM="$IM" CLI_PKG="$CLI_PKG" CLI_VERSION="$CLI_VERSION" CLI_PLATFORM_PKG="$CLI_PLATFORM_PKG" \
    NPM_REGISTRY="$NPM_REGISTRY" LARK_BINARY_BASE="$LARK_BINARY_BASE" sh /build/install-cli.sh && rm -rf /build
COPY dist/ /app/
COPY tools/ /app/tools/
ENV IM_TOOLS_DIR=/app/tools PORT=8000 DWS_NO_UPDATE_CHECK=1 SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
USER node
EXPOSE 8000
ENTRYPOINT ["node", "/app/server.mjs"]

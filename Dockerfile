# Meridian dev/build toolchain: Rust 1.89, Agave CLI 3.1.14, Anchor CLI 1.2.1, Node 22.23.3, pnpm 10.
# Anchor CLI is installed from the prebuilt release binary -- see the note below the Anchor CLI step
# and DECISIONS.md §7.
# Base is Debian trixie, not bookworm as first planned: anchor-litesvm's prebuilt native binary
# (litesvm-linux-x64-gnu) needs a glibc symbol (`__isoc23_strtol`) only present from glibc 2.38;
# bookworm ships 2.36. Trixie ships 2.41. See DECISIONS.md §7, 2026-10-06.
# Everything needed to build, test and run the project lives in this image. Nothing is installed
# on the host (DECISIONS.md §7). Layer order is base tools -> Agave -> Anchor -> Node -> pnpm so
# that changes to later steps do not invalidate the expensive earlier ones.
FROM rust:1.89-trixie

ARG UID=1000
ARG GID=1000

ENV DEBIAN_FRONTEND=noninteractive

# ---- base tools -----------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        pkg-config \
        libssl-dev \
        libudev-dev \
        curl \
        git \
        jq \
        ca-certificates \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# non-root user matching the host uid/gid so bind-mounted files and named
# volumes stay writable without chown dances at runtime. Some hosts pass a
# GID that already exists in the base image (e.g. macOS GID 20 = dialout):
# in that case join the existing group instead of trying to create it again,
# which would fail and abort the later chown step.
RUN if getent group "${GID}" >/dev/null 2>&1; then \
        useradd -m -u "${UID}" -g "${GID}" -s /bin/bash dev; \
    else \
        groupadd -g "${GID}" dev \
        && useradd -m -u "${UID}" -g "${GID}" -s /bin/bash dev; \
    fi

# ---- Agave CLI (Solana) ----------------------------------------------------
# Installed as root into /opt/solana so it is readable by any user, then
# exposed on PATH for every shell in the image.
ARG AGAVE_VERSION=v3.1.14
RUN curl -sSfL "https://release.anza.xyz/${AGAVE_VERSION}/install" -o /tmp/agave-install.sh \
    && HOME=/opt/solana-home sh /tmp/agave-install.sh \
    && mv /opt/solana-home/.local/share/solana /opt/solana \
    && ln -sfn "/opt/solana/install/releases/${AGAVE_VERSION#v}/solana-release" /opt/solana/install/active_release \
    && rm -rf /opt/solana-home /tmp/agave-install.sh \
    && chown -R "${UID}:${GID}" /opt/solana
ENV PATH="/opt/solana/install/active_release/bin:${PATH}"

# ---- Anchor CLI -------------------------------------------------------------
# Installed from the prebuilt release binary rather than built from source:
# no Rust toolchain mismatch to patch around, and it drops the image's build
# time and size considerably. See DECISIONS.md §7.
ARG ANCHOR_VERSION=1.2.1
RUN curl -fsSL -o /usr/local/bin/anchor \
        "https://github.com/solana-foundation/anchor/releases/download/v${ANCHOR_VERSION}/anchor-${ANCHOR_VERSION}-x86_64-unknown-linux-gnu" \
    && chmod +x /usr/local/bin/anchor \
    && anchor --version

# ---- Node 22 LTS ------------------------------------------------------------
# Exact version pin (not "latest 22.x") so the container matches the README's
# documented Node version precisely.
ARG NODE_MAJOR=22
ARG NODE_VERSION=22.23.3-1nodesource1
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get update && apt-get install -y --no-install-recommends "nodejs=${NODE_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

# ---- pnpm 10 via corepack ----------------------------------------------------
# COREPACK_HOME is set explicitly (and chowned below) so the `dev` user hits
# the same prepared-binary cache baked in at build time instead of
# re-downloading pnpm on first run.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
    && corepack prepare pnpm@10.0.0 --activate

# Cargo registry and the Anchor target dir are named volumes mounted here by
# compose.yml. The mount points must exist and be owned by the non-root user
# in the image *before* the volume is first attached, because Docker copies
# an existing directory's ownership into a fresh named volume on first mount.
# Only these writable locations are chowned to the dev user -- the Rust and
# Anchor toolchains under /usr/local/cargo and /usr/local/rustup stay
# root-owned (they are world-readable/executable by default in the base
# image, which is all a non-root user needs to run them).
RUN mkdir -p /usr/local/cargo/registry /work/target /run/keys /home/dev/.pnpm-store \
    && chown -R "${UID}:${GID}" /usr/local/cargo/registry /work /run/keys /opt/corepack /home/dev/.pnpm-store

# ---- Playwright (headless shell only) for the Wave 7 web E2E smoke suite --
# Installed as root, into /opt/pw-browsers rather than the default
# ~/.cache/ms-playwright (which would land under /home/dev and need its own
# chown dance every time the named volumes shuffle ownership). `--with-deps`
# pulls in the handful of system libraries Chromium needs that aren't already
# covered by this image's base-tools layer. Pinned to the same version as
# `@playwright/test` in `web/package.json` -- the browser binaries and the
# test runner that drives them must always match exactly.
#
# Fix #22: this suite never launches a headed browser, so only
# `chromium-headless-shell` is installed -- not full headed Chromium too,
# which `install --with-deps chromium` would otherwise pull down alongside
# it. apt's package lists and npx/npm's download cache are removed in this
# same layer so neither survives in the final image.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
ARG PLAYWRIGHT_VERSION=1.63.0
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium-headless-shell \
    && chown -R "${UID}:${GID}" /opt/pw-browsers \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache/ms-playwright

USER dev
WORKDIR /work

CMD ["bash"]

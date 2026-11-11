#!/usr/bin/env bash
# One-time setup: CHIMERA (the voice engine, a submodule) and its wasm, the film engine, the MCP
# server and its headless browser. Needs Rust (rustup), Bun and git; ffmpeg for MP4 output.
set -euo pipefail
cd "$(dirname "$0")"
for c in git cargo bun; do command -v "$c" >/dev/null || { echo "needs $c" >&2; exit 1; }; done
command -v ffmpeg >/dev/null || echo "note: no ffmpeg, so films come out as WebM (brew install ffmpeg for MP4)"
git submodule update --init
command -v rustup >/dev/null && rustup target add wasm32-unknown-unknown
(cd chimera && bun install && bun run wasm)
(cd engine && cargo build --release)
(cd mcp && bun install && bunx playwright-core install chromium-headless-shell)
# the server copies the film page into the CHIMERA checkout; keep those copies out of its git status
EX="$(git -C chimera rev-parse --path-format=absolute --git-path info/exclude)"
mkdir -p "$(dirname "$EX")"
grep -qx 'film.html' "$EX" 2>/dev/null || printf 'film.html\nsrc/film.ts\npublic/film/\n' >> "$EX"
echo
echo "Ready. Add it to Claude Code:"
echo "  claude mcp add chimera-film -- bun \"$PWD/mcp/server.ts\""

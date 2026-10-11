#!/bin/bash
# Removes the confirmation waits recorded by record-demo.mts from the scene WebMs,
# using the intervals in <dir>/cuts.json ({"04-maker": [[from,to],...], ...}, seconds
# from the scene's recording start). Each scene is rewritten in place (the original
# is kept as raw/<scene>.full.webm). Host ffmpeg.
#   bash web/e2e/cut-waits.sh design/demo
set -euo pipefail
DIR="${1:?scene dir}"
FFMPEG="${FFMPEG:-/usr/bin/ffmpeg}"
cd "$DIR"
mkdir -p raw
python3 - <<'PY' | while IFS=$'\t' read -r scene expr; do
import json
for scene, ivs in json.load(open("cuts.json")).items():
    if not ivs: continue
    expr = "+".join(f"between(t,{a},{b})" for a, b in ivs)
    print(f"{scene}\t{expr}")
PY
  [ -f "$scene.webm" ] || { echo "no $scene.webm"; continue; }
  [ -f "raw/$scene.full.webm" ] || cp "$scene.webm" "raw/$scene.full.webm"
  "$FFMPEG" -nostdin -y -loglevel error -i "raw/$scene.full.webm" -vf "select='not($expr)',setpts=N/FRAME_RATE/TB" -r 25 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 4M -an "$scene.webm"
  echo "$scene: cut $expr -> $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$scene.webm")s"
done

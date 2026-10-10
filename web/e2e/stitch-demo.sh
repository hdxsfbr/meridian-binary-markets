#!/bin/bash
# Stitches the scenes recorded by record-demo.mts (PHASE=pre then PHASE=post)
# into one MP4. Run inside the dev container:
#   docker exec -w /work/web meridian-web-devnet-e2e bash e2e/stitch-demo.sh /work/design/demo
# Output: <dir>/meridian-demo.mp4 (H.264, 1440x900, 30 fps) and <dir>/scenes.txt.
set -euo pipefail
DIR="${1:-/work/design/demo}"
FFMPEG="${FFMPEG:-$(ls /opt/pw-browsers/ffmpeg-*/ffmpeg-linux 2>/dev/null | head -1)}"
[ -x "$FFMPEG" ] || { echo "ffmpeg not found"; exit 1; }
cd "$DIR"
: > scenes.txt
for f in $(ls *.webm | sort); do
  # Re-encode each scene to a uniform intermediate so the concat demuxer never
  # sees mismatched streams (Playwright's WebMs have variable frame timing).
  "$FFMPEG" -y -loglevel error -i "$f" -r 30 -vf "scale=1440:900:flags=lanczos,format=yuv420p" -c:v libx264 -preset medium -crf 20 -an "tmp-${f%.webm}.mp4"
  echo "file 'tmp-${f%.webm}.mp4'" >> scenes.txt
done
"$FFMPEG" -y -loglevel error -f concat -safe 0 -i scenes.txt -c copy meridian-demo.mp4
rm -f tmp-*.mp4
"$FFMPEG" -i meridian-demo.mp4 2>&1 | grep -E "Duration|Stream" | head -2
ls -la meridian-demo.mp4

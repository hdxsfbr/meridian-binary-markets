#!/bin/bash
# Muxes per-scene narration WAVs onto the scenes recorded by record-demo.mts and
# produces the final narrated MP4. For every scene NN-*.webm with a matching
# NN.wav in the narration directory, the scene is held on its last frame if the
# narration (plus 0.4 s of air) runs longer than the footage; scenes without a
# clip keep their length with silence. Needs the host ffmpeg (libx264 + aac).
#   bash web/e2e/mux-narration.sh design/demo /home/hdx/code/chatterbox-play/outputs/agent_tts/meridian
# Output: <dir>/meridian-demo-narrated.mp4
set -euo pipefail
DIR="${1:?scene dir}"
NARR="${2:?narration dir}"
FFMPEG="${FFMPEG:-/usr/bin/ffmpeg}"
FFPROBE="${FFPROBE:-/usr/bin/ffprobe}"
TAIL_AIR="${TAIL_AIR:-0.4}"
SLACK="${SLACK:-2.0}"
cd "$DIR"
: > narrated.txt
for f in $(ls *.webm | sort); do
  n="${f%%-*}"
  vdur=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$f")
  clip="$NARR/$n.wav"
  if [ -f "$clip" ]; then
    adur=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$clip")
    # Footage much longer than its narration (devnet confirmation stalls) is time-compressed
    # down to narration + SLACK so the voice never trails off into silence; footage shorter
    # than its narration is held on the last frame.
    target=$(python3 -c "print(float('$adur') + float('$SLACK'))")
    if python3 -c "import sys; sys.exit(0 if float('$vdur') > float('$target') else 1)"; then
      factor=$(python3 -c "print(float('$target') / float('$vdur'))")
      need="$target"
      "$FFMPEG" -y -loglevel error -i "$f" -i "$clip" \
        -filter_complex "[0:v]scale=1440:900:flags=lanczos,format=yuv420p,setpts=PTS*${factor},fps=30[v];[1:a]aresample=48000,apad[a]" \
        -map "[v]" -map "[a]" -t "$need" -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 160k "nar-${n}.mp4"
      echo "scene $n video ${vdur}s narration ${adur}s -> ${need}s (compressed x$(python3 -c "print(round(1/float('$factor'),2))"))"
    else
      need=$(python3 -c "print(max(float('$vdur'), float('$adur') + float('$TAIL_AIR')))")
      pad=$(python3 -c "print(max(0.0, float('$need') - float('$vdur')))")
      "$FFMPEG" -y -loglevel error -i "$f" -i "$clip" \
        -filter_complex "[0:v]scale=1440:900:flags=lanczos,format=yuv420p,fps=30,tpad=stop_mode=clone:stop_duration=${pad}[v];[1:a]aresample=48000,apad[a]" \
        -map "[v]" -map "[a]" -t "$need" -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 160k "nar-${n}.mp4"
      echo "scene $n video ${vdur}s narration ${adur}s -> ${need}s"
    fi
  else
    "$FFMPEG" -y -loglevel error -i "$f" -f lavfi -i anullsrc=r=48000:cl=stereo \
      -filter_complex "[0:v]scale=1440:900:flags=lanczos,format=yuv420p,fps=30[v]" \
      -map "[v]" -map 1:a -t "$vdur" -shortest -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 160k "nar-${n}.mp4"
    echo "scene $n video ${vdur}s (no narration)"
  fi
  echo "file 'nar-${n}.mp4'" >> narrated.txt
done
"$FFMPEG" -y -loglevel error -f concat -safe 0 -i narrated.txt -c copy meridian-demo-narrated.mp4
rm -f nar-*.mp4 narrated.txt
"$FFPROBE" -v error -show_entries format=duration -of csv=p=0 meridian-demo-narrated.mp4 | awk '{printf "total %.1fs\n", $1}'
ls -la meridian-demo-narrated.mp4

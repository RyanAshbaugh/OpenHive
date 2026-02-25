#!/bin/bash
set -euo pipefail

# ============================================================================
# clean-video.sh — Remove status bar from simulator recordings/screenshots
# ============================================================================
#
# Paints over the status bar (clock, icons, dynamic island) by sampling a
# thin strip of the app's background just below the status bar and stretching
# it upward. Works on both videos (.mov/.mp4) and images (.png/.jpg).
#
# Usage:
#   ./clean-video.sh <input> [options]
#
# Options:
#   --status-bar <px>   Status bar height in pixels (auto-detected from device if not set)
#   --device <name>     Device name for auto-detection (e.g. "iPhone 17 Pro")
#   --resize <WxH>      Also resize to target dimensions (e.g. "886x1920")
#   --output <path>     Output path (default: input with -clean suffix)
#
# The status bar height varies by device. Known values (simulator px):
#
#   Device              Status Bar (px)
#   ─────────────────── ───────────────
#   iPhone 16 Pro       180
#   iPhone 16 Pro Max   180
#   iPhone 17 Pro       180
#   iPhone 17 Pro Max   180
#   iPhone Air          145
#   iPad Pro 12.9"      60
#   iPad Pro 11"        60
#

# --- Device → status bar height lookup ---
get_status_bar_height() {
  local device="$1"
  case "$device" in
    *"iPhone 16 Pro"*)  echo 180 ;;
    *"iPhone 17 Pro"*)  echo 180 ;;
    *"iPhone Air"*)     echo 145 ;;
    *"iPhone 16"*)      echo 170 ;;
    *"iPhone 17"*)      echo 170 ;;
    *"iPad Pro 12"*)    echo 60 ;;
    *"iPad Pro 11"*)    echo 60 ;;
    *"iPad"*)           echo 60 ;;
    *"iPhone"*)         echo 170 ;; # safe default for modern iPhones
    *)                  echo 180 ;; # fallback
  esac
}

# --- Parse args ---
INPUT=""
STATUS_BAR=""
DEVICE=""
RESIZE=""
OUTPUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --status-bar) STATUS_BAR="$2"; shift 2 ;;
    --device)     DEVICE="$2"; shift 2 ;;
    --resize)     RESIZE="$2"; shift 2 ;;
    --output|-o)  OUTPUT="$2"; shift 2 ;;
    -*)           echo "Unknown option: $1"; exit 1 ;;
    *)            INPUT="$1"; shift ;;
  esac
done

if [ -z "$INPUT" ]; then
  echo "Usage: clean-video.sh <input> [--status-bar <px>] [--device <name>] [--resize <WxH>] [--output <path>]"
  exit 1
fi

if [ ! -f "$INPUT" ]; then
  echo "ERROR: File not found: $INPUT"
  exit 1
fi

# Auto-detect status bar height from device name
if [ -z "$STATUS_BAR" ]; then
  if [ -n "$DEVICE" ]; then
    STATUS_BAR=$(get_status_bar_height "$DEVICE")
  elif [ -n "${SIM_NAME:-}" ]; then
    STATUS_BAR=$(get_status_bar_height "$SIM_NAME")
  else
    STATUS_BAR=180
  fi
fi

# Determine if input is video or image
EXT="${INPUT##*.}"
EXT_LOWER=$(echo "$EXT" | tr '[:upper:]' '[:lower:]')

IS_VIDEO=false
case "$EXT_LOWER" in
  mov|mp4|m4v|avi|mkv) IS_VIDEO=true ;;
esac

# Default output path
if [ -z "$OUTPUT" ]; then
  DIR=$(dirname "$INPUT")
  BASE=$(basename "$INPUT" ".$EXT")
  if [ "$IS_VIDEO" = true ]; then
    OUTPUT="$DIR/${BASE}-clean.mp4"
  else
    OUTPUT="$DIR/${BASE}-clean.$EXT"
  fi
fi

echo "Cleaning: $INPUT"
echo "  Status bar: ${STATUS_BAR}px"
[ -n "$RESIZE" ] && echo "  Resize: $RESIZE"
echo "  Output: $OUTPUT"

if [ "$IS_VIDEO" = true ]; then
  # Video: use ffmpeg
  # 1. Crop a 2px strip just below the status bar
  # 2. Scale it to fill the status bar area
  # 3. Overlay it on the original to paint over the status bar
  # 4. Optionally resize
  FILTER="[0:v]crop=iw:2:0:${STATUS_BAR},scale=iw:${STATUS_BAR}[topfill];[0:v][topfill]overlay=0:0[clean]"

  if [ -n "$RESIZE" ]; then
    W="${RESIZE%%x*}"
    H="${RESIZE##*x}"
    FILTER="${FILTER};[clean]scale=${W}:-2,crop=${W}:${H}:0:in_h-${H}[out]"
    MAP="-map [out]"
  else
    MAP="-map [clean]"
  fi

  # Get the true playback duration from the MOV edit list (QuickTime-reported duration).
  # Simulator .mov files use edit lists that extend beyond the last frame's timestamp,
  # holding the final frame on screen. ffmpeg ignores this by default, so we use tpad
  # to clone the last frame and -t to match the original playback length.
  EDIT_DUR=$(ffprobe -v debug "$INPUT" 2>&1 \
    | grep -o 'edit list 0 - media time: [0-9]*, duration: [0-9]*' \
    | grep -o 'duration: [0-9]*' | grep -o '[0-9]*')
  STREAM_TB=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=time_base -of csv=p=0 "$INPUT" | sed 's|1/||')
  [ -z "$STREAM_TB" ] && STREAM_TB=600

  if [ -n "$EDIT_DUR" ] && [ "$EDIT_DUR" -gt 0 ] 2>/dev/null; then
    REAL_DUR=$(python3 -c "print(f'{$EDIT_DUR / $STREAM_TB:.6f}')")
    STREAM_DUR=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$INPUT")
    PAD_DUR=$(python3 -c "print(f'{$EDIT_DUR / $STREAM_TB - ${STREAM_DUR:-0}:.6f}')")
    IS_POSITIVE=$(python3 -c "print('yes' if $EDIT_DUR / $STREAM_TB > ${STREAM_DUR:-0} else 'no')")
    if [ "$IS_POSITIVE" = "yes" ]; then
      # Append the clean step with tpad to clone the last frame for the missing time
      FILTER="${FILTER};[clean]tpad=stop_mode=clone:stop_duration=${PAD_DUR}[padded]"
      if [ -n "$RESIZE" ]; then
        W="${RESIZE%%x*}"
        H="${RESIZE##*x}"
        FILTER="${FILTER};[padded]scale=${W}:-2,crop=${W}:${H}:0:in_h-${H}[out]"
        MAP="-map [out]"
      else
        MAP="-map [padded]"
      fi
    fi
  fi

  ffmpeg -i "$INPUT" -filter_complex "$FILTER" \
    $MAP -fps_mode passthrough \
    -c:v h264 -pix_fmt yuv420p -movflags +faststart -an -y "$OUTPUT" 2>/dev/null

else
  # Image: use ImageMagick
  if ! command -v magick &>/dev/null; then
    echo "ERROR: ImageMagick (magick) is required for image cleaning"
    exit 1
  fi

  if [ -n "$RESIZE" ]; then
    W="${RESIZE%%x*}"
    H="${RESIZE##*x}"
    magick "$INPUT" \
      \( -clone 0 -crop "0x2+0+${STATUS_BAR}" +repage -scale "x${STATUS_BAR}!" \) \
      -compose over -geometry +0+0 -composite \
      -resize "${W}x" -gravity South -crop "${W}x${H}+0+0" +repage \
      "$OUTPUT"
  else
    magick "$INPUT" \
      \( -clone 0 -crop "0x2+0+${STATUS_BAR}" +repage -scale "x${STATUS_BAR}!" \) \
      -compose over -geometry +0+0 -composite \
      "$OUTPUT"
  fi
fi

echo "Done: $OUTPUT"

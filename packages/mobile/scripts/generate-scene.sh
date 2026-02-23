#!/bin/bash
set -euo pipefail

# ============================================================================
# generate-scene.sh — Generate a simulation scene JS file using an AI agent
# ============================================================================
#
# Usage: ohmobile generate-scene <scene-name> -d "description"
#
# Reads existing scenes as examples, builds a prompt with simulation framework
# docs, and calls the configured agent CLI to generate a new scene file.

SCENE_NAME="${1:-}"
shift 2>/dev/null || true

# Parse flags
DESCRIPTION=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--description)
      DESCRIPTION="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$SCENE_NAME" ] || [ -z "$DESCRIPTION" ]; then
  echo "Usage: ohmobile generate-scene <scene-name> -d \"description\""
  echo ""
  echo "Generate a simulation scene JS file using an AI agent."
  echo ""
  echo "Options:"
  echo "  -d, --description  Description of the scene to generate (required)"
  echo ""
  echo "Examples:"
  echo "  ohmobile generate-scene test-plots -d \"Plots screen showing hours going up\""
  echo "  ohmobile generate-scene reading-heatmap -d \"Heatmap of daily reading minutes\""
  exit 1
fi

# ── Find scenes directory ──────────────────────────────────────

SCENES_DIR=""
for candidate in \
  "$PROJECT_DIR/src/simulation/scenes" \
  "$PROJECT_DIR/simulation/scenes" \
  "$PROJECT_DIR/scenes"; do
  if [ -d "$candidate" ]; then
    SCENES_DIR="$candidate"
    break
  fi
done

if [ -z "$SCENES_DIR" ]; then
  echo "Error: No scenes directory found in $PROJECT_DIR" >&2
  echo "Expected one of: src/simulation/scenes/, simulation/scenes/, scenes/" >&2
  exit 1
fi

SCENE_FILE="$SCENES_DIR/${SCENE_NAME}.js"

# ── Check if scene already exists ──────────────────────────────

if [ -f "$SCENE_FILE" ]; then
  echo "Scene already exists: $SCENE_FILE"
  echo "Remove it first if you want to regenerate."
  exit 0
fi

# ── Gather example scenes ─────────────────────────────────────

EXAMPLES=""
EXAMPLE_COUNT=0

# Sort by file size (shortest first), skip index.js, take up to 2
for f in $(ls -S -r "$SCENES_DIR"/*.js 2>/dev/null); do
  [ -f "$f" ] || continue
  fname="$(basename "$f" .js)"
  [ "$fname" = "index" ] && continue

  EXAMPLES="${EXAMPLES}
### Example: ${fname}.js
\`\`\`javascript
$(cat "$f")
\`\`\`
"
  EXAMPLE_COUNT=$((EXAMPLE_COUNT + 1))
  [ "$EXAMPLE_COUNT" -ge 2 ] && break
done

# ── Extract available screens from existing scenes ─────────────

SCREENS=""
for f in "$SCENES_DIR"/*.js; do
  [ -f "$f" ] || continue
  fname="$(basename "$f" .js)"
  [ "$fname" = "index" ] && continue
  # Extract screen: 'value' lines
  screen=$(grep -o "screen:[[:space:]]*'[^']*'" "$f" 2>/dev/null | head -1 | sed "s/screen:[[:space:]]*'//;s/'//")
  if [ -n "$screen" ]; then
    SCREENS="${SCREENS}  - ${screen}\n"
  fi
done
SCREENS=$(echo -e "$SCREENS" | sort -u)

# ── Build prompt ──────────────────────────────────────────────

PROMPT="You are generating a simulation scene file for an @openhive/mobile project.

## Simulation Framework API

Scenes export a default object with this structure:

\`\`\`javascript
import { seededRandom, dateSeed } from '@openhive/mobile/simulation';
import { localYMD } from '../../utils/dateProvider';

const seed = (date, offset) => seededRandom(dateSeed(date, localYMD) + offset);

export default {
  startDate: 'YYYY-MM-DD',   // simulation start date
  endDate: null,               // null = today
  stepDays: 1,                 // days to advance per tick
  intervalMs: 200,             // milliseconds between ticks (~5 days/sec)
  screen: 'ScreenName',       // which screen to navigate to

  profile: {
    // Entities to create for the simulation:
    templates: [{ name, color, category, default_duration_minutes }],  // activity templates
    habits: [{ name, unit, color }],                                    // habit trackers
    heatmaps: [{ names: [...], lookback_steps, step_size_days, show_on_home }],
    goals: [{ title, total, show_on_home }],
    metricPlots: [{ event_name|metric_name, lookback_days, show_on_home, title }],
    // Optional: stats, calendar entries, etc.
  },

  dataGenerators: {
    // Each key matches a template/habit name from profile
    // Function receives a Date, returns a numeric value (0 = skip day)
    'EntityName': (date) => {
      const rand = seed(date, 1);  // deterministic random for this date
      // Return minutes for templates, reps/count for habits, 0 for no activity
      return rand() < 0.8 ? 50 + rand() * 40 : 0;
    },
  },
};
\`\`\`

### Key utilities:
- \`seededRandom(seed)\` — returns a function producing values in [0, 1) (Park-Miller LCG)
- \`dateSeed(date, localYMD)\` — produces numeric seed from a date (deterministic)
- Always use \`const seed = (date, offset) => seededRandom(dateSeed(date, localYMD) + offset)\`
- Use different offset values for different generators to avoid correlated randomness

### Available profile fields:
- \`templates\`: Activity templates (tracked by duration in minutes)
- \`habits\`: Habit trackers (tracked by count/reps)
- \`heatmaps\`: Heatmap visualizations (reference template/habit names)
- \`goals\`: Goal trackers (cumulative targets)
- \`metricPlots\`: Plot visualizations (\`event_name\` for templates, \`metric_name\` for habits)

${EXAMPLES:+## Example scenes from this project
$EXAMPLES}

${SCREENS:+## Available screens in this app
$SCREENS}

## Task

Generate a scene file named \"${SCENE_NAME}.js\" based on this description:

${DESCRIPTION}

## Output

Write the scene file to: ${SCENE_FILE}

## Rules
- Write ONLY the JavaScript file — no other files
- Follow the exact import pattern shown above
- Use seeded random for all randomness (deterministic)
- Use realistic data ranges for the activity types
- Start date should be a few months in the past
- Keep the scene config object clean and well-commented
- Make sure dataGenerators keys exactly match the names in profile templates/habits"

# ── Call agent CLI ────────────────────────────────────────────

AGENT="${AGENT_CLI:-claude}"

echo "=== Generating scene: ${SCENE_NAME} ==="
echo "  Agent:       $AGENT"
echo "  Description: $DESCRIPTION"
echo "  Output:      $SCENE_FILE"
echo ""

case "$AGENT" in
  claude)
    $AGENT -p "$PROMPT" --allowedTools "Edit,Write,Read" --output-format text
    ;;
  *)
    # Generic fallback: assume agent accepts -p for prompt
    $AGENT -p "$PROMPT" > "$SCENE_FILE"
    ;;
esac

# ── Validate output ───────────────────────────────────────────

VALID=true

if ! grep -q "export default" "$SCENE_FILE"; then
  echo "Warning: Generated file missing 'export default'" >&2
  VALID=false
fi

if ! grep -q "dataGenerators" "$SCENE_FILE"; then
  echo "Warning: Generated file missing 'dataGenerators'" >&2
  VALID=false
fi

if [ "$VALID" = true ]; then
  echo ""
  echo "Scene generated: $SCENE_FILE"
else
  echo ""
  echo "Scene generated with warnings: $SCENE_FILE"
  echo "Review and fix the file manually if needed."
fi

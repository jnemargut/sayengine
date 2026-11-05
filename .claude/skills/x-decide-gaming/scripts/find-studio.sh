#!/bin/sh
# Print the path of the AI-first studio's `studio` launcher, or exit 1 if there is none.
# Order: $STUDIO_HOME/studio, the repo this skill folder lives in (works through symlinks),
# then `studio` on PATH. The studio works on the folder it is started in, so callers run
# "<printed path>" <command> from the game's own folder.
if [ -n "$STUDIO_HOME" ] && [ -x "$STUDIO_HOME/studio" ]; then echo "$STUDIO_HOME/studio"; exit 0; fi
HERE=$(cd -P "$(dirname "$0")" 2>/dev/null && pwd)
if [ -n "$HERE" ]; then
  ROOT=$(cd -P "$HERE/../../../.." 2>/dev/null && pwd)
  if [ -n "$ROOT" ] && [ -x "$ROOT/studio" ] && [ -f "$ROOT/packages/cli/studio.ts" ]; then echo "$ROOT/studio"; exit 0; fi
fi
if command -v studio >/dev/null 2>&1; then command -v studio; exit 0; fi
echo "no studio found: set STUDIO_HOME to the studio repo, or run ./studio install-skills from it" >&2
exit 1

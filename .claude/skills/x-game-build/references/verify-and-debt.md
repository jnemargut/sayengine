# Proving a fix, and the tool-debt ledger

Contents: verified fresh build · before and after · subagent reports · the tool-debt ledger · folding debt back into the studio.

## Verified fresh build

A render only proves something if it came from the code you just changed. Builds fail quietly: a bundler error leaves the old bundle in place, a server keeps serving a cached one, a probe that filters its output for "error" hides the failure.

Before any render that backs a claim:

1. Build, and treat a non-zero exit or any error line as a stop, not a warning. Never filter build output down to lines that say "error".
2. Record the bundle's (or exported mesh's) hash and modified time: `shasum -a 256 dist/game.js` or the GLB. It must differ from the previous render's.
3. Load the page with a cache-busting query (`?v=<hash>`) or a fresh headless profile, and have the page print a build stamp (the hash or a build time) somewhere the screenshot shows, or log it to the console and check it.
4. Only then render.

## Before and after

Every claimed visual fix ("the eyes no longer slice", "the seam is gone") gets:

- the previous render and the new one **side by side** in one image (same camera, same pose, same lighting), saved under `.decisions/` next to the other renders, named `<thing>-before.jpg` / `<thing>-after.jpg` or one `<thing>-compare.jpg`;
- the build hash of each half;
- one line saying what to look at.

Read the image yourself before reporting. If the difference isn't visible at the size the human will see it, the fix is not done; say "not visible yet" rather than "fixed". Close-up crops are fine as long as the crop is stated.

## Subagent reports

A builder subagent's "fixed" means nothing without its before/after image and build hash. When orchestrating, open the images and compare. If a claimed fix isn't visible, send it back with the image, or check for a stale build first.

## The tool-debt ledger (`PAIN.md`)

The game is also a test bed for the studio. Keep `PAIN.md` in the game's code folder, append-only, numbered, grouped by build step:

```
## Step 3: presets build
19. **No way to look at a character without the browser view.** What hurt, in one or two sentences.
    What the game did instead. → the studio tool that would fix it. [open | fixed in studio | game-only]
```

Log an item whenever a studio tool was missing, weak or wrong, a workaround went into game code, or a process step failed (a stale build, a change that skipped review). Keep the wording generic enough that each item could be copied into a studio issue as is: "a quadruped with a cat's head", not the game's name or story.

Prefer fixing in the studio when the fix is general and not too long; then mark the item `fixed in studio` with the commit, and remove the game-side workaround after re-importing (keep it behind a query flag for comparison if useful).

## Folding debt back into the studio

At the end of v1 (and when the ledger passes about 20 open items), offer once: "PAIN.md has N open items; M look general. Want me to take them to the studio?" On yes: group them by studio area, write each as a generic studio task (no private names, paths or content), and hand them to the studio's own skill. The game stays private; only the lesson travels.

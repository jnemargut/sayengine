// Keep a headless studio view connected to the daemon (texture bakes on game import need one).
// STUDIO_CHROME_PORT=9541 node checkpoint-pocket-raleigh/craft/recipe/view-keepalive.ts [minutes]
import { withPage } from '../../../packages/game/src/chrome.ts';
const port = process.env.STUDIO_PORT ?? '4660';
const minutes = Number(process.argv[2] ?? 240);
await withPage(`http://localhost:${port}/`, { width: 1280, height: 800 }, async () => {
  console.log('view connected');
  await new Promise((r) => setTimeout(r, minutes * 60_000));
});

// Keep the studio view open in headless Chrome (the texture bake in `studio export --target godot|web`
// paints through the open view), so cast exports can run unattended.
//   STUDIO_PORT=4691 node bench/studio-view-headless.ts [seconds]
import { chromium } from 'playwright-core';
const port = Number(process.env.STUDIO_PORT ?? 4517);
const seconds = Number(process.argv[2] ?? 3600);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('view error', e.message));
await page.goto(`http://127.0.0.1:${port}/`);
console.log(`STUDIO_VIEW open on ${port}`);
await new Promise((r) => setTimeout(r, seconds * 1000));
await browser.close();

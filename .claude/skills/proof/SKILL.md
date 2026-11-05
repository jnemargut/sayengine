---
name: proof
description: Prove a game still looks right and runs on a phone-sized screen before calling it done — render fixed views with the clock and seed pinned in Godot and the web build, diff them against the approved pictures with FLIP, check budgets (draw calls, triangles, file size, frame time), and run an imitated phone (WebKit at phone size, Chrome with the CPU slowed). Use for /proof, or when the user asks to check, verify, regression-test, compare engines, or test a game on a phone.
---

# /proof — pictures, budgets, an imitated phone (Decision 31, Mac only)

Everything runs on this Mac with free tools: Godot, Chrome, Playwright's WebKit, NVIDIA's FLIP (`~/.studio-tools/venv`, `pip install flip-evaluator pillow`), ffmpeg. It does **not** test a real iPhone: phone memory limits and GPU precision ("fizzing") can still slip through — say so when reporting.

The user's request: **$ARGUMENTS**

## Set up once per game

`./studio proof init --project <game> --views '[{"name":"plaza","position":[x,y,z],"target":[x,y,z],"fov":55}]' --phone '{"path":[[x,y,z],…],"seconds":8,"throttle":4}'` writes `proof/proof.json` (budgets: `--budgets '{"drawCalls":1500,"triangles":1500000,"glbMB":40,"phoneP50Ms":34,"phoneP95Ms":70}'`). Pick 6–12 views a player will actually see: street level at eye height, the landmarks, one aerial.

## Every change

1. `./studio proof views --project <godot game> --against <web game>` → per view `same` / `changed` / `new` (FLIP mean and share of changed pixels vs `proof/approved/<engine>/`), budgets, Godot-vs-web parity (advisory until the look module pins them together) and a contact sheet. **Read the sheet and the `.diff.png` heat maps** of anything changed.
2. Intended change? `./studio proof approve --project <game>` (or `--views a,b`). Unintended: fix it, don't approve it.
3. First run: `--approve-new true` accepts views with no reference yet — look at them first.

## Before sharing

`./studio proof phone --project <web game>` walks the phone path in WebKit (390×844 @3x) and in Chrome with the CPU slowed 4×: p50/p95/max frame time, long frames, draw calls, JS heap, console errors, a screenshot of each. Report the numbers and the caveat.

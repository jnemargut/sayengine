// Styles for the timeline dock (kept beside the dock so the view's stylesheet stays untouched).
export const TIMELINE_CSS = `
.vp-col { display:flex; flex-direction:column; gap:var(--space-3); min-height:0; min-width:0; }
.vp-col > .viewport { flex:1 1 auto; }
.vp-col .checks { max-height:58px; overflow:hidden; }
.tl-dock { flex:0 0 auto; background:var(--color-50); border-radius:var(--radius-lg); box-shadow:var(--shadow-2); display:grid; grid-template-columns:minmax(0,1fr) min(290px, 34%); min-height:0; overflow:hidden; font-size:var(--text-xs); color:var(--color-700); }
.tl-dock.empty { display:none; }
.tl-main { display:flex; flex-direction:column; min-width:0; border-right:1px solid var(--color-200); }
.tl-bar { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--color-200); white-space:nowrap; overflow:hidden; }
.tl-bar button { font:inherit; border:none; border-radius:999px; background:var(--color-100); color:var(--color-800); padding:3px 10px; cursor:pointer; }
.tl-bar button.on { background:var(--color-800); color:var(--color-50); }
.tl-bar .tl-time { font-family:var(--font-mono); color:var(--color-900); min-width:92px; }
.tl-bar .tl-moment { color:var(--color-600); overflow:hidden; text-overflow:ellipsis; flex:1 1 auto; min-width:0; }
.tl-bar .tl-moment b { color:var(--color-900); font-weight:600; }
.tl-bar .tl-perf { font-family:var(--font-mono); color:var(--color-500); font-size:10px; flex:0 0 auto; }
.tl-bar .tl-perf.bad { color:#a8483a; }
.tl-body { display:grid; grid-template-columns:clamp(110px, 22%, 168px) minmax(0,1fr); max-height:178px; overflow-y:auto; position:relative; }
.tl-labels { padding-top:18px; }
.tl-label { height:22px; display:flex; align-items:center; gap:6px; padding:0 8px; cursor:pointer; overflow:hidden; white-space:nowrap; border-bottom:1px solid var(--color-100); }
.tl-label.sel { background:var(--color-100); color:var(--color-900); font-weight:600; }
.tl-label i { width:8px; height:8px; border-radius:2px; flex:0 0 auto; }
.tl-label span { overflow:hidden; text-overflow:ellipsis; }
.tl-label select { font:inherit; font-size:10px; border:1px solid var(--color-200); background:var(--color-50); color:var(--color-700); border-radius:4px; max-width:70px; margin-left:auto; }
.tl-lanes { position:relative; cursor:ew-resize; }
.tl-lanes canvas { display:block; width:100%; }
.tl-side { padding:8px 10px; overflow-y:auto; max-height:216px; display:flex; flex-direction:column; gap:7px; }
.tl-side h4 { margin:0; font-size:var(--text-xs); color:var(--color-900); font-weight:600; }
.tl-side .tl-addr { font-family:var(--font-mono); font-size:10px; color:var(--color-500); word-break:break-all; }
.tl-side .chips { display:flex; flex-wrap:wrap; gap:4px; }
.tl-side button { font:inherit; border:1px solid var(--color-200); background:var(--color-50); color:var(--color-800); border-radius:999px; padding:2px 9px; cursor:pointer; }
.tl-side button.primary { background:var(--color-800); color:var(--color-50); border-color:var(--color-800); }
.tl-side input[type=text] { font:inherit; width:100%; border:1px solid var(--color-200); background:var(--color-50); color:var(--color-900); border-radius:6px; padding:4px 7px; }
.tl-side .row { display:flex; gap:5px; align-items:center; }
.tl-side .knob { display:grid; grid-template-columns:86px 1fr 40px; gap:6px; align-items:center; }
.tl-side .knob input { width:100%; accent-color:var(--color-700); }
.tl-side .knob b { font-family:var(--font-mono); font-weight:500; text-align:right; color:var(--color-900); }
.tl-side .bad { color:#a8483a; }
.tl-side .take { display:flex; gap:5px; align-items:center; }
.tl-side .take span { flex:1; }
.tl-side .ask { border:1px solid var(--color-200); border-radius:8px; padding:6px; display:flex; flex-direction:column; gap:5px; }
.tl-side .ask .q { color:var(--color-900); font-weight:600; }
.tl-side .muted { color:var(--color-500); }
.tl-side code { font-family:var(--font-mono); font-size:10px; }
.tl-bar .tl-shotcam { display:none; }
.tl-dock.no-tracks .tl-bar, .tl-dock.no-tracks .tl-body { display:none; }
.tl-dock.no-tracks .tl-day { border-bottom:none; }
.tl-dock.no-tracks { grid-template-columns:minmax(0,1fr); }
.tl-dock.no-tracks .tl-side { display:none; }
.tl-dock.no-tracks .tl-main { border-right:none; }
.tl-dock.has-shots .tl-bar .tl-shotcam { display:inline-block; }
.tl-three { position:absolute; left:12px; right:12px; top:12px; z-index:6; background:var(--color-50); border-radius:var(--radius-lg); box-shadow:var(--shadow-2); padding:10px 12px; font-size:var(--text-xs); color:var(--color-700); }
.tl-three .q { font-weight:600; color:var(--color-900); margin-bottom:8px; } .tl-three .q span { font-weight:400; color:var(--color-500); }
.tl-three .row { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px; }
.tl-three .tk { display:flex; flex-direction:column; gap:5px; }
.tl-three .img { aspect-ratio:32/9; background:var(--color-100); border-radius:8px; overflow:hidden; display:flex; align-items:center; justify-content:center; gap:2px; color:var(--color-400); }
.tl-three .img img { width:50%; height:100%; object-fit:cover; display:block; }
.tl-three .se { display:flex; justify-content:space-around; font-size:10px; color:var(--color-500); margin-top:-3px; }
.tl-frame { position:absolute; left:0; right:0; top:50%; transform:translateY(-50%); aspect-ratio:16/9; max-height:100%; margin:auto; box-shadow:0 0 0 2000px rgba(0,0,0,.28); outline:1px solid rgba(255,255,255,.55); pointer-events:none; z-index:2; }
.tl-three b { color:var(--color-900); }
.tl-three button { font:inherit; border:1px solid var(--color-200); background:var(--color-50); color:var(--color-800); border-radius:999px; padding:3px 10px; cursor:pointer; align-self:flex-start; }
.tl-three .tk button { background:var(--color-800); color:var(--color-50); border-color:var(--color-800); }
.tl-three .foot { display:flex; gap:10px; align-items:center; margin-top:8px; color:var(--color-500); }
`;

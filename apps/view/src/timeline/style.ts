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
`;

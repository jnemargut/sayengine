# Decision page skeleton

Contents: style block · body · when chosen · rules that keep pages honest.

The house style for every game decision page: blueprint-ink palette, system sans, no external scripts. Copy the whole `<style>` block into each page (pages must be self-contained), then fill the body. Keep option cards in the order A–D; put the recommended one first (A) unless the human asked for a different order.

## Style block

```html
<style>
/* Decision hub palette: blueprint ink #23466f + drafting paper (same as decisions 1–10) */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #f1f5f9; color: #1a1a2e; min-height: 100vh; padding: 2rem; line-height: 1.6; }
header.page { text-align: center; margin: 0 auto 2.5rem; padding-bottom: 1.5rem; border-bottom: 2px solid #e2e8f0; max-width: 1200px; }
.decision-number { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #64748b; }
header.page h1 { font-size: 1.6rem; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; margin-top: 0.25rem; }
.category-badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; margin-top: 0.5rem; background: #efeaf8; color: #4b3a8c; }
.triage-badge { display:inline-block; padding:4px 12px; border-radius:999px; font-size:0.7rem; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; margin-top:0.5rem; margin-left:6px; }
.triage-badge.one-way { background:#fbecea; color:#a83a32; }
.triage-badge.stakes-high { background:#fff7ed; color:#a8481a; }
.decision-description { font-size: 1rem; color: #475569; margin: 0.75rem auto 0; max-width: 800px; line-height: 1.7; }
.preview-link { display:inline-block; margin-top:0.75rem; font-size:0.8rem; font-weight:600; color:#2c6e48; text-decoration:none; border:1px solid #b9dcc6; background:#edf6f0; padding:0.4rem 0.9rem; border-radius:999px; }
.instruction { margin-top: 1rem; font-size: 0.85rem; background: #e8eef6; color: #23466f; padding: 0.6rem 1.25rem; border-radius: 8px; display: inline-block; border: 1px solid #b7c7dc; }
.options-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; max-width: 1200px; margin: 0 auto 3rem; }
.option-card { background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 4px 16px rgba(0,0,0,0.04); border: 2px solid #e2e8f0; display: flex; flex-direction: column; }
.option-card:hover { border-color: #23466f; }
.card-header { padding: 1rem 1.25rem 0.75rem; border-bottom: 1px solid #f1f5f9; display: flex; flex-direction: column; gap: 0.2rem; }
.card-header-top { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.option-label { font-size: 0.65rem; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
.option-a .option-label { color: #4b3a8c; } .option-b .option-label { color: #1d6f80; } .option-c .option-label { color: #2c6e48; } .option-d .option-label { color: #a83a32; }
.option-title { font-size: 1.05rem; font-weight: 600; color: #0f172a; }
.card-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
.pick-badge { background: #b86e0a; color: white; padding: 3px 10px; border-radius: 999px; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; white-space: nowrap; }
.confidence-badge { padding:3px 10px; border-radius:999px; font-size:0.65rem; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; white-space:nowrap; color:white; }
.confidence-badge.strong { background:#2c6e48; }
.chosen-badge { background: #2c6e48; color: white; padding: 3px 10px; border-radius: 999px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; display: none; }
.option-card.chosen { border: 3px solid #2c6e48; }
.option-card.chosen .chosen-badge { display: inline-block; }
.option-card.not-chosen { opacity: 0.55; filter: grayscale(20%); }
.visual-preview { padding: 1.25rem; background: #f8fafc; display: flex; flex-direction: column; gap: 10px; justify-content: center; flex: 1; min-height: 300px; }
.option-summary { padding: 1rem 1.25rem; font-size: 0.875rem; color: #334155; line-height: 1.65; border-top: 1px solid #f1f5f9; }
.verdict { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid #f1f5f9; }
.pros, .cons { padding: 1rem 1.25rem; }
.pros { border-right: 1px solid #f1f5f9; }
.pros h3, .cons h3 { font-size: 0.65rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.5rem; }
.pros h3 { color: #2c6e48; } .cons h3 { color: #b42323; }
.verdict ul { list-style: none; }
.verdict li { font-size: 0.8rem; color: #475569; line-height: 1.5; padding: 0.15rem 0 0.15rem 1rem; position: relative; }
.pros li::before { content: "✓ "; color: #2c6e48; font-weight: 700; position: absolute; left: 0; }
.cons li::before { content: "! "; color: #b42323; font-weight: 700; position: absolute; left: 0; }
.card-footer { padding: 0.75rem 1.25rem; background: #f8fafc; border-top: 1px solid #f1f5f9; }
.tell-ai { font-size: 0.75rem; color: #64748b; background: #f1f5f9; padding: 0.35rem 0.65rem; border-radius: 6px; display: block; font-family: 'SF Mono', monospace; }
.case-against { max-width:1200px; margin:0 auto 3rem; background:white; border-left:4px solid #b42323; border-radius:12px; padding:1.25rem 1.5rem; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
.case-against h2 { font-size:0.8rem; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#b42323; margin-bottom:0.5rem; }
.case-against p { font-size:0.9rem; color:#334155; line-height:1.65; }
.assumptions { max-width:1200px; margin:0 auto 3rem; font-size:0.85rem; color:#475569; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:12px; padding:1rem 1.5rem; }
.assumptions h2 { font-size:0.7rem; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#64748b; margin-bottom:0.4rem; }
.assumptions ul { padding-left:1.1rem; }
.research-context { max-width:1200px; margin:0 auto 3rem; background:white; border-radius:12px; padding:1.25rem 1.5rem; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
.research-context h2 { font-size:0.8rem; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#23466f; margin-bottom:0.75rem; }
.findings { list-style:none; padding:0; }
.findings li { font-size:0.875rem; color:#334155; line-height:1.6; padding:0.35rem 0 0.35rem 1.1rem; position:relative; }
.findings li::before { content:"→"; position:absolute; left:0; color:#23466f; font-weight:700; }
.cite { color:#23466f; font-size:0.8rem; text-decoration:none; border-bottom:1px dotted #23466f; margin-left:4px; }
.experts-box { margin-top:1rem; border-left:4px solid #b86e0a; background:#fdf6e9; border-radius:0 12px 12px 0; padding:1rem 1.25rem; }
.experts-box h3 { font-size:0.7rem; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#8a5208; margin-bottom:0.35rem; }
.experts-box p { font-size:0.85rem; color:#451a03; line-height:1.6; }
.comparison-section { max-width: 1200px; margin: 0 auto 3rem; }
.comparison-section h2 { font-size: 1.1rem; font-weight: 700; color: #0f172a; margin-bottom: 1rem; }
.comparison-table-wrapper { overflow-x: auto; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.comparison-table { width: 100%; border-collapse: collapse; background: white; font-size: 0.85rem; }
.comparison-table th { padding: 0.85rem 1rem; text-align: left; font-weight: 700; font-size: 0.75rem; letter-spacing: 0.05em; text-transform: uppercase; border-bottom: 2px solid #e2e8f0; }
.comparison-table th:first-child { background: #f8fafc; color: #64748b; }
.comparison-table th.col-a { color: #4b3a8c; } .comparison-table th.col-b { color: #1d6f80; } .comparison-table th.col-c { color: #2c6e48; } .comparison-table th.col-d { color: #a83a32; }
.comparison-table td { padding: 0.75rem 1rem; border-bottom: 1px solid #f1f5f9; color: #334155; vertical-align: top; }
.comparison-table td:first-child { font-weight: 600; color: #475569; background: #f8fafc; white-space: nowrap; }
.comparison-table .col-pick { background: #fdf6e9 !important; }
.comparison-table .col-chosen { background: #edf6f0 !important; }
.page-footer { max-width: 1200px; margin: 0 auto; text-align: center; padding: 1.5rem; background: white; border-radius: 12px; }
.page-footer p { font-size: 0.85rem; color: #64748b; margin: 0.3rem 0; }
.back-link { display: inline-block; margin-bottom: 1.5rem; font-size: 0.85rem; color: #23466f; text-decoration: none; }
.triage-badge.two-way { background:#e6f3f6; color:#1d6f80; }
.triage-badge.stakes-med { background:#f1f5f9; color:#475569; }
.confidence-badge.lean { background:#d97706; color:white; }
.confidence-badge.toss-up { background:#64748b; color:white; }
.option-summary ul { padding-left:1.2rem; margin:0.3rem 0; }
.proof { margin-top:8px; font-size:0.72rem; color:#334155; background:#f8fafc; border-radius:8px; padding:8px 10px; }
.play { width:100%; aspect-ratio:16/10; border:1px solid #e2e8f0; border-radius:10px; background:#dfe7ef; }
</style>
```

## Body

```html
<a href="index.html" class="back-link">← All decisions</a>

<header class="page">
  <span class="decision-number">Decision 2 · Step 1 of 7 · Bread at Dawn</span>
  <h1>Three Pillars</h1>
  <span class="category-badge">Concept</span>
  <span class="triage-badge two-way">🔁 Two-way door</span>
  <span class="triage-badge stakes-high">High stakes</span>
  <p class="decision-description">Why this decision matters for this game, in two or three sentences.</p>
  <a class="preview-link" href="preview.html">See the game so far →</a><br>
  <p class="instruction">Respond with: <strong>"Option A"</strong> · <strong>"Option A but [change]"</strong> · <strong>"more options"</strong></p>
</header>

<main class="options-grid">
  <article class="option-card option-a">
    <div class="card-header">
      <div class="card-header-top">
        <span class="option-label">Option A</span>
        <div class="card-badges">
          <span class="pick-badge">My pick: short reason</span>
          <span class="confidence-badge strong">Strong pick</span>
        </div>
      </div>
      <h2 class="option-title">Option Title</h2>
    </div>
    <div class="visual-preview">
      <!-- the visual: playable iframe (class="play"), a render <img>, a <video>, or an HTML/SVG diagram -->
      <div class="proof"><b>What it feels like:</b> one or two sentences in the player's shoes.</div>
    </div>
    <div class="option-summary">Plain-English summary, three to five sentences.</div>
    <div class="verdict">
      <div class="pros"><h3>Works well when</h3><ul><li>…</li></ul></div>
      <div class="cons"><h3>Watch out for</h3><ul><li>…</li></ul></div>
    </div>
    <div class="card-footer"><code class="tell-ai">Respond with: "Option A"</code></div>
  </article>
  <!-- option-b, option-c, option-d: same structure, no pick or confidence badges -->
</main>

<section class="case-against"><h2>The case against my pick</h2><p>…</p></section>
<section class="assumptions"><h2>Assumptions and tripwires</h2><ul><li>…</li></ul></section>

<section class="comparison-section">
  <h2>Side by side</h2>
  <div class="comparison-table-wrapper">
  <table class="comparison-table">
    <thead><tr><th></th><th class="col-a col-pick">A · …</th><th class="col-b">B · …</th><th class="col-c">C · …</th><th class="col-d">D · …</th></tr></thead>
    <tbody>
      <tr><td>Dimension</td><td class="col-pick">…</td><td>…</td><td>…</td><td>…</td></tr>
      <tr><td>Undo cost</td><td class="col-pick">…</td><td>…</td><td>…</td><td>…</td></tr>
    </tbody>
  </table>
  </div>
</section>

<section class="research-context">
  <h2>Research context</h2>
  <ul class="findings"><li>Finding.<a class="cite" href="https://…">Source</a></li></ul>
</section>

<div class="page-footer"><p>Respond with: <strong>"Option A"</strong>, <strong>"Option B but [your change]"</strong>, or <strong>"more options"</strong></p></div>
```

## When chosen

Add `chosen` to the picked card's class and `not-chosen` to the others; add `<span class="chosen-badge">Chosen</span>` to the picked card's badges; move `col-pick` to `col-chosen` if the pick changed.

## Rules that keep pages honest

- Distinct link text for every citation (no two links with the same words).
- No placeholder copy left behind ("your product", "Item A", "lorem").
- Every badge fits its card at 1400 px wide: keep pick badges under about 45 characters.
- Render the page and look at it before opening it for the human.

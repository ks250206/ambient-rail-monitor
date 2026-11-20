#!/usr/bin/env python3
"""Generic quicklook (not a spectral fit); makes a reproducible HTML report and, if available, PPTX using the Science Tokyo design palette."""
import csv
import datetime
import html
import json
import math
import sys
from pathlib import Path

source, output, run_id = sys.argv[1:4]
out = Path(output)
out.mkdir(parents=True, exist_ok=True)
rows = []
with open(source, encoding="utf-8-sig", errors="replace", newline="") as file:
    dialect = csv.excel_tab if source.lower().endswith(".tsv") else csv.excel
    reader = csv.reader(file, dialect=dialect)
    headers = next(reader, [])
    for cells in reader:
        if len(cells) < 2:
            continue
        try:
            a = float(cells[0])
            b = float(cells[1])
            if math.isfinite(a) and math.isfinite(b):
                rows.append((a, b))
        except ValueError:
            continue

if not rows:
    rows = [(i, float(i * i)) for i in range(1, 12)]
    fallback = True
else:
    fallback = False

xs = [r[0] for r in rows]
ys = [r[1] for r in rows]
xmin, xmax = min(xs), max(xs)
ymin, ymax = min(ys), max(ys)
if xmax == xmin:
    xmax = xmin + 1
if ymax == ymin:
    ymax = ymin + 1

W, H = 1000, 340
padx, pady = 74, 36
coords = " ".join(
    f"{padx + (x - xmin) / (xmax - xmin) * (W - 2 * padx):.1f},"
    f"{H - pady - (y - ymin) / (ymax - ymin) * (H - 2 * pady):.1f}"
    for x, y in rows[:2000]
)
xtitle = headers[0] if headers else "x"
ytitle = headers[1] if len(headers) > 1 else "y"

# CVD-safe Science Tokyo palette (#435ea5 Navy 700 primary series on white canvas)
svg = f'''<svg viewBox="0 0 {W} {H}" role="img" aria-label="Numeric quicklook chart" xmlns="http://www.w3.org/2000/svg">
<rect width="{W}" height="{H}" fill="#ffffff" rx="12" stroke="#cfdbed" stroke-width="1.5" />
<path d="M{padx} {H / 2} H{W - padx}" stroke="#e4ebf6" stroke-dasharray="5 5" />
<path d="M{padx} {pady} V{H - pady} H{W - padx}" fill="none" stroke="#595959" stroke-width="1.5" />
<polyline points="{coords}" fill="none" stroke="#435ea5" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" />
<text x="{W / 2}" y="{H - 8}" font-family="'Hind', 'Noto Sans JP', sans-serif" text-anchor="middle" font-size="13" font-weight="600" fill="#333333">{html.escape(xtitle)}</text>
<text x="24" y="{H / 2}" font-family="'Hind', 'Noto Sans JP', sans-serif" text-anchor="middle" font-size="13" font-weight="600" fill="#333333" transform="rotate(-90,24,{H / 2})">{html.escape(ytitle)}</text>
<text x="{padx}" y="{H - 12}" font-family="ui-monospace, monospace" font-size="12" fill="#595959">{xmin:.2f}</text>
<text x="{W - padx}" y="{H - 12}" font-family="ui-monospace, monospace" font-size="12" text-anchor="end" fill="#595959">{xmax:.2f}</text>
</svg>'''

warning = (
    "Fallback synthetic data used because no numeric columns were found."
    if fallback
    else "Descriptive quicklook only. No background subtraction, peak assignment, calibration or physically validated fitting has been performed."
)

report = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RAILFLOW • {html.escape(run_id)} report</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{{box-sizing:border-box}}
body{{margin:0;background:#ffffff;color:#333333;font-family:'Hind','Noto Sans JP',sans-serif;line-height:1.6}}
.band{{position:relative;background:#1c3177;color:#ffffff;padding:36px 24px 44px;overflow:hidden}}
.band svg{{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}}
.band-inner{{position:relative;max-width:1040px;margin:0 auto}}
.eyebrow{{display:inline-block;font-size:12px;font-weight:700;color:#cfdbed}}
h1{{font-size:34px;line-height:1.2;margin:10px 0 8px;color:#ffffff;letter-spacing:-.02em}}
.meta{{color:#cfdbed;font-size:14px;margin:0;overflow-wrap:anywhere}}
main{{max-width:1040px;margin:0 auto;padding:28px 24px 48px}}
h2{{font-size:20px;color:#1c3177;margin:0 0 16px}}
.stats{{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}}
.stat{{padding:18px 20px;background:#f2f4f9;border:1px solid #cfdbed;border-radius:10px}}
.stat span{{display:block;font-size:12px;font-weight:600;color:#435ea5}}
.stat b{{display:block;font-size:24px;margin-top:8px;color:#1c3177;font-variant-numeric:tabular-nums}}
.panel{{background:#f2f4f9;border:1px solid #cfdbed;border-radius:12px;padding:24px;margin:24px 0}}
.warn{{border-left:4px solid #fb5b01;background:#ffeee2;color:#6d2700;padding:16px 20px;border-radius:6px;margin:24px 0}}
.warn b{{display:block;margin-bottom:4px}}
.warn p{{margin:0;font-size:14px}}
.muted{{color:#595959;font-size:13px}}
@media(max-width:700px){{.stats{{grid-template-columns:repeat(2,1fr)}}}}
</style></head>
<body>
<header class="band">
  <svg viewBox="0 0 1200 220" preserveAspectRatio="none" aria-hidden="true">
    <rect width="1200" height="220" fill="#1c3177" />
    <polygon points="0,160 1200,205 1200,220 0,220" fill="#7f96c2" />
    <polygon points="780,220 1200,140 1200,220" fill="#ffffff" />
  </svg>
  <div class="band-inner">
    <span class="eyebrow">Science Tokyo · RAILFLOW / Reproducible Quicklook</span>
    <h1>Experimental Data Report</h1>
    <p class="meta">Run {html.escape(run_id)} · Input {html.escape(Path(source).name)} · {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}</p>
  </div>
</header>
<main>
  <div class="stats">
    <div class="stat"><span>Records</span><b>{len(rows)}</b></div>
    <div class="stat"><span>X range</span><b>{xmin:.2f}–{xmax:.2f}</b></div>
    <div class="stat"><span>Y minimum</span><b>{ymin:.2f}</b></div>
    <div class="stat"><span>Y maximum</span><b>{ymax:.2f}</b></div>
  </div>
  <section class="panel"><h2>Numeric overview</h2>{svg}</section>
  <div class="warn"><b>Scientific review required</b><p>{html.escape(warning)}</p></div>
  <p class="muted">Institute of Science Tokyo — RAILFLOW demo report generated using standard-library parsing, not a scientific XPS interpretation. Use the real agent adapter to run domain-specific analysis.</p>
</main></body></html>'''

(out / "report.html").write_text(report, encoding="utf-8")
(out / "quicklook.svg").write_text(svg, encoding="utf-8")

# Optional real PPTX if python-pptx is installed (Science Tokyo light slide pattern, Yu Gothic font).
try:
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.util import Inches, Pt

    prs = Presentation()
    prs.slide_width = Inches(13.33)
    prs.slide_height = Inches(7.5)

    SCIENCE_BLUE = RGBColor(28, 49, 119)
    SUB_COLOR = RGBColor(127, 150, 194)
    NAVY_700 = RGBColor(67, 94, 165)
    TEXT_PRIMARY = RGBColor(51, 51, 51)
    TEXT_MUTED = RGBColor(89, 89, 89)
    WHITE = RGBColor(255, 255, 255)

    def textbox(slide, x, y, w, h, text, size=20, color=TEXT_PRIMARY, bold=False):
        shape = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        tf = shape.text_frame
        tf.word_wrap = True
        tf.text = text
        p = tf.paragraphs[0]
        p.font.name = "Yu Gothic"
        p.font.size = Pt(size)
        p.font.bold = bold
        p.font.color.rgb = color
        return shape

    for k in range(2):
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        bg = slide.background.fill
        bg.solid()
        bg.fore_color.rgb = WHITE

        # Top Science Blue header bar and bottom sub-color bar anchored to slide edges
        top_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0), Inches(0), Inches(13.33), Inches(0.24))
        top_bar.fill.solid()
        top_bar.fill.fore_color.rgb = SCIENCE_BLUE
        top_bar.line.fill.background()

        bottom_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0), Inches(7.28), Inches(13.33), Inches(0.22))
        bottom_bar.fill.solid()
        bottom_bar.fill.fore_color.rgb = SUB_COLOR
        bottom_bar.line.fill.background()

        textbox(slide, 0.7, 0.55, 11.9, 0.35, "Science Tokyo  /  RAILFLOW SCIENTIFIC QUICKLOOK", 14, NAVY_700, True)
        textbox(
            slide,
            0.7,
            1.05,
            11.9,
            1.05,
            "Experimental Data Report" if k == 0 else "Numeric Quicklook",
            36,
            SCIENCE_BLUE,
            True,
        )
        textbox(slide, 0.72, 2.05, 11.5, 0.65, f"{Path(source).name} • {len(rows)} numeric rows", 18, TEXT_MUTED)
        if k == 0:
            for i, line in enumerate(
                [
                    f"X range:     {xmin:.3f} – {xmax:.3f}",
                    f"Y range:     {ymin:.3f} – {ymax:.3f}",
                    "Report type: descriptive quicklook",
                    "Validation:  scientific interpretation pending",
                ]
            ):
                textbox(slide, 0.85, 2.95 + i * 0.68, 11.2, 0.55, line, 21, TEXT_PRIMARY)
        else:
            textbox(
                slide,
                0.85,
                3.0,
                11.2,
                1.4,
                "See report.html for the Science Tokyo-styled SVG figure.\nNo calibrated spectral fit or peak assignment is claimed.",
                21,
                TEXT_PRIMARY,
            )
        textbox(
            slide,
            0.7,
            6.75,
            11.9,
            0.4,
            "Institute of Science Tokyo • DEMO descriptive statistics only • not a scientific interpretation",
            13,
            TEXT_MUTED,
        )
    prs.save(out / "report.pptx")
except ImportError:
    pass

print(json.dumps({"artifacts": [p.name for p in out.iterdir()]}))

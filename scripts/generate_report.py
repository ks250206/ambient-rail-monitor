#!/usr/bin/env python3
"""Generic quicklook (not a spectral fit); makes a reproducible HTML report and, if available, PPTX."""
import csv, sys, os, html, math, json, statistics, datetime
from pathlib import Path

source, output, run_id = sys.argv[1:4]
out = Path(output)
out.mkdir(parents=True, exist_ok=True)
rows=[]
with open(source, encoding='utf-8-sig', errors='replace', newline='') as file:
    sample = file.read(2048)
    file.seek(0)
    dialect = csv.excel_tab if source.lower().endswith('.tsv') else csv.excel
    reader=csv.reader(file, dialect=dialect)
    headers=next(reader, [])
    for cells in reader:
        if len(cells)<2: continue
        try:
            a=float(cells[0]); b=float(cells[1]);
            if math.isfinite(a) and math.isfinite(b): rows.append((a,b))
        except ValueError: continue
if not rows:
    rows=[(i,float(i*i)) for i in range(1,12)]
    fallback=True
else:
    fallback=False
xs=[r[0] for r in rows]
ys=[r[1] for r in rows]
xmin,xmax=min(xs),max(xs)
ymin,ymax=min(ys),max(ys)
if xmax==xmin:xmax=xmin+1
if ymax==ymin:ymax=ymin+1
W,H=1000,330
padx,pady=70,35
coords=' '.join(f'{padx+(x-xmin)/(xmax-xmin)*(W-2*padx):.1f},{H-pady-(y-ymin)/(ymax-ymin)*(H-2*pady):.1f}' for x,y in rows[:2000])
xtitle=headers[0] if headers else 'x'
ytitle=headers[1] if len(headers)>1 else 'y'
svg=f'''<svg viewBox="0 0 {W} {H}" role="img" aria-label="Numeric quicklook chart" xmlns="http://www.w3.org/2000/svg">
<rect width="{W}" height="{H}" fill="#111b2c" rx="16" />
<path d="M{padx} {pady} V{H-pady} H{W-padx}" fill="none" stroke="#576779" stroke-width="1.5"/>
<path d="M{padx} {H/2} H{W-padx}" stroke="#27354a" stroke-dasharray="4 4" />
<polyline points="{coords}" fill="none" stroke="#72e7bb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
<text x="{W/2}" y="{H-5}" font-family="Arial" text-anchor="middle" font-size="14" fill="#adbcd0">{html.escape(xtitle)}</text>
<text x="24" y="{H/2}" font-family="Arial" text-anchor="middle" font-size="14" fill="#adbcd0" transform="rotate(-90,24,{H/2})">{html.escape(ytitle)}</text>
<text x="{padx}" y="{H-11}" font-size="12" fill="#adbec9">{xmin:.2f}</text>
<text x="{W-padx}" y="{H-11}" font-size="12" text-anchor="end" fill="#adbec9">{xmax:.2f}</text>
</svg>'''
warning='Fallback synthetic data used because no numeric columns were found.' if fallback else 'Descriptive quicklook only. No background subtraction, peak assignment, calibration or physically validated fitting has been performed.'
report=f'''<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Railflow • {html.escape(run_id)} report</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{{box-sizing:border-box}}body{{margin:0;background:#0c1320;color:#ebf4f5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}}main{{max-width:1050px;margin:45px auto;padding:25px}}h1{{font-size:40px;letter-spacing:-.04em}}h2{{font-size:23px}}.muted{{color:#9dacbf}}.badge{{border:1px solid #547165;border-radius:50px;padding:5px 10px;color:#8ef2cc;font-size:12px}}.panel{{background:#162236;border:1px solid #28354b;border-radius:20px;padding:30px;margin:28px 0}}.stats{{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}}.stat{{padding:22px;border:1px solid #2b3d50;border-radius:14px}}.stat b{{display:block;font-size:24px;margin-top:12px;color:#79e7bc}}.warn{{border-left:4px solid #e5b36b;background:#3d322b;padding:18px;border-radius:5px}}@media(max-width:700px){{.stats{{grid-template-columns:repeat(2,1fr)}}}}</style></head>
<body><main><span class="badge">RAILFLOW / REPRODUCIBLE QUICKLOOK</span><h1>Experimental data report</h1>
<p class="muted">Run {html.escape(run_id)} · Input {html.escape(Path(source).name)} · {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}</p>
<div class="stats"><div class="stat">Records<b>{len(rows)}</b></div><div class="stat">X range<b>{xmin:.2f}–{xmax:.2f}</b></div><div class="stat">Y minimum<b>{ymin:.2f}</b></div><div class="stat">Y maximum<b>{ymax:.2f}</b></div></div>
<section class="panel"><h2>Numeric overview</h2>{svg}</section>
<div class="warn"><b>Scientific review required</b><p>{html.escape(warning)}</p></div>
<p class="muted">This report is a demo generated using standard-library parsing, not a scientific XPS interpretation. Use the real agent adapter to run domain-specific analysis.</p>
</main></body></html>'''
(out/'report.html').write_text(report,encoding='utf-8')
(out/'quicklook.svg').write_text(svg,encoding='utf-8')
# Optional real PPTX if python-pptx installed.
try:
    from pptx import Presentation
    from pptx.util import Inches,Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN
    prs=Presentation();prs.slide_width=Inches(13.33);prs.slide_height=Inches(7.5)
    def textbox(slide,x,y,w,h,text,size=22,color=(235,244,245),bold=False):
        sh=slide.shapes.add_textbox(Inches(x),Inches(y),Inches(w),Inches(h));tf=sh.text_frame;tf.word_wrap=True
        tf.text=text;p=tf.paragraphs[0];p.font.name='Aptos';p.font.size=Pt(size);p.font.bold=bold;p.font.color.rgb=RGBColor(*color)
        return sh
    for k in range(2):
        slide=prs.slides.add_slide(prs.slide_layouts[6]);bg=slide.background.fill;bg.solid();bg.fore_color.rgb=RGBColor(12,19,32)
        textbox(slide,.7,.4,12,.35,'RAILFLOW  /  SCIENTIFIC QUICKLOOK',14,(113,226,179),True)
        textbox(slide,.7,1.05,12,1.15,'Experimental data report' if k==0 else 'Numeric quicklook',38,(241,246,250),True)
        textbox(slide,.72,2.15,11,.8,f'{Path(source).name} • {len(rows)} numeric rows',19,(175,195,207))
        if k==0:
            for i,line in enumerate([f'X range     {xmin:.3f} – {xmax:.3f}',f'Y range     {ymin:.3f} – {ymax:.3f}',
                'Report type     descriptive quicklook', 'Validation     scientific interpretation pending']):
                textbox(slide,.85,3.1+i*.7,11,.6,line,23,(226,239,247))
        else:
            textbox(slide,.9,3.2,11,1.25,'See report.html for an interactive-friendly SVG figure.\nNo calibrated spectral fit or peak assignment is claimed.',22,(223,230,239))
        textbox(slide,.7,6.95,12,.4,'DEMO • descriptive statistics only • not a scientific interpretation',14,(215,171,108))
    prs.save(out/'report.pptx')
except ImportError:
    pass
print(json.dumps({'artifacts':[p.name for p in out.iterdir()]}))

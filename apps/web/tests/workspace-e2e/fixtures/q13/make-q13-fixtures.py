#!/usr/bin/env python3
"""Q-13 E2E document fixtures, made with real producers (python-pptx, python-docx,
openpyxl, reportlab, Pillow). Each file carries one unique search word.
The scanned PDF has its text ONLY as pixels (no text layer). Usage: python3 make-q13-fixtures.py <outdir>"""
import sys, os
from pptx import Presentation
from pptx.util import Inches
from docx import Document
from openpyxl import Workbook
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)
P = lambda n: os.path.join(out, n)

p = Presentation()
s = p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text = 'Aurora programme review'; s.placeholders[1].text = 'Board update, November'
s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = 'Milestones'
tf = s.placeholders[1].text_frame; tf.text = 'Pilot launched in Tromso'; tf.add_paragraph().text = 'Second wave planned for spring'
s.notes_slide.notes_text_frame.text = 'Remind the board about the quokka sponsorship'
s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = 'Budget by region'
t = s.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(6), Inches(1)).table
t.cell(0, 0).text = 'Region'; t.cell(0, 1).text = 'Spend'; t.cell(1, 0).text = 'Nordics'; t.cell(1, 1).text = '1.2M'
s.notes_slide.notes_text_frame.text = 'Figures exclude the lighthouse grant'
p.save(P('aurora-review.pptx'))

d = Document(); d.add_heading('Hangar operations', 1); d.add_paragraph('The zeppelin hangar checklist covers mooring masts and helium.'); d.save(P('hangar.docx'))

wb = Workbook(); ws = wb.active; ws.title = 'Catering'; ws.append(['Item', 'Qty']); ws.append(['Marzipan cake', 12]); wb.save(P('catering.xlsx'))

c = canvas.Canvas(P('fjord.pdf'), pagesize=A4); c.drawString(72, 760, 'Fjord ferry timetable for the winter season.'); c.showPage(); c.save()

img = Image.new('L', (1200, 300), 255); dr = ImageDraw.Draw(img)
try: font = ImageFont.load_default(size=64)
except TypeError: font = ImageFont.load_default()
dr.text((40, 110), 'Pelican survey results', fill=0, font=font)
png = P('scan.tmp.png'); img.save(png)
c = canvas.Canvas(P('pelican-scan.pdf'), pagesize=A4); c.drawImage(png, 40, 500, width=515, height=129); c.showPage(); c.save()
os.remove(png)

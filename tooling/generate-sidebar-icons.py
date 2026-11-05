from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'apps/miniprogram/miniprogram/assets/ui'
scale = 8
for name, color in {'light': '#fff0db', 'dark': '#8b5d3c'}.items():
    image = Image.new('RGBA', (24 * scale, 24 * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((3 * scale, 4 * scale, 21 * scale, 20 * scale), radius=2 * scale, outline=color, width=round(1.5 * scale))
    draw.line((9 * scale, 4.5 * scale, 9 * scale, 19.5 * scale), fill=color, width=round(1.5 * scale))
    image.resize((96, 96), Image.Resampling.LANCZOS).save(root / ('sidebar-' + name + '.png'))

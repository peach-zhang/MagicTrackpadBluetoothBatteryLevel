"""Remove only the connected light exterior and export a Windows icon."""
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

root = Path(__file__).resolve().parent
source = Image.open(root / "trackpad-battery-icon-source.png").convert("RGBA")
r, g, b, _ = source.split()
lightest_floor = ImageChops.darker(ImageChops.darker(r, g), b)
exterior = lightest_floor.point(lambda value: 255 if value >= 220 else 0)
# Flood-fill all four exterior corners, preserving the enclosed silver trackpad.
for corner in [(0, 0), (source.width - 1, 0), (0, source.height - 1),
               (source.width - 1, source.height - 1)]:
    if exterior.getpixel(corner) == 255:
        ImageDraw.floodfill(exterior, corner, 128)
source.putalpha(exterior.point(lambda value: 0 if value == 128 else 255))
# Trim the original white matte fringe before making an antialiased edge.
source.putalpha(source.getchannel("A").filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(0.5)))
source = source.crop(source.getbbox())
source.thumbnail((960, 960), Image.Resampling.LANCZOS)
icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
icon.alpha_composite(source, ((1024 - source.width) // 2, (1024 - source.height) // 2))
icon.save(root / "trackpad-battery-icon.png")
sizes = [(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)]
icon.save(root / "trackpad-battery.ico", sizes=sizes)
with Image.open(root / "trackpad-battery.ico") as check:
    actual_sizes = sorted(check.ico.sizes())
    assert actual_sizes == sorted(sizes), actual_sizes
assert icon.getpixel((0, 0))[3] == 0
print("PNG: 1024 x 1024, transparent exterior")
print("ICO sizes:", actual_sizes)

#!/usr/bin/env python3
"""Build the Wukong Codex app-icon master from the approved avatar asset."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/assets/jarvis-wukong-summon-head-transparent.png"
OUTPUT = ROOT / "src-tauri/icons/wukong-codex-icon-master.png"
SIZE = 1024


def vertical_gradient(top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    strip = Image.new("RGB", (1, SIZE))
    pixels = strip.load()
    for y in range(SIZE):
        progress = y / (SIZE - 1)
        pixels[0, y] = tuple(
            round(start + (end - start) * progress)
            for start, end in zip(top, bottom)
        )
    return strip.resize((SIZE, SIZE)).convert("RGBA")


def radial_glow(
    center: tuple[int, int],
    radius: int,
    color: tuple[int, int, int],
    strength: int,
) -> Image.Image:
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    alpha = Image.new("L", (SIZE, SIZE), 0)
    pixels = alpha.load()
    cx, cy = center
    for y in range(max(0, cy - radius), min(SIZE, cy + radius)):
        for x in range(max(0, cx - radius), min(SIZE, cx + radius)):
            distance = math.hypot(x - cx, y - cy) / radius
            if distance < 1:
                pixels[x, y] = round(strength * (1 - distance) ** 1.8)
    glow.paste((*color, 255), (0, 0, SIZE, SIZE), alpha)
    return glow


def build_icon() -> None:
    avatar = Image.open(SOURCE).convert("RGBA")
    # A square head crop removes the shoulders while preserving the crown,
    # eyes, beard, and the characteristic blue/gold rim light.
    avatar = avatar.crop((190, 280, 1064, 1154))
    avatar = ImageEnhance.Contrast(avatar).enhance(1.06)
    avatar = ImageEnhance.Sharpness(avatar).enhance(1.08)
    avatar.thumbnail((864, 864), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    panel_mask = Image.new("L", (SIZE, SIZE), 0)
    panel_draw = ImageDraw.Draw(panel_mask)
    panel_draw.rounded_rectangle((44, 44, 980, 980), radius=218, fill=255)

    panel = vertical_gradient((5, 13, 21), (22, 10, 5))
    panel = Image.alpha_composite(panel, radial_glow((220, 520), 620, (0, 124, 255), 122))
    panel = Image.alpha_composite(panel, radial_glow((820, 440), 590, (255, 143, 24), 112))
    panel.putalpha(panel_mask)
    canvas.alpha_composite(panel)

    position = ((SIZE - avatar.width) // 2, 82)
    avatar_alpha = avatar.getchannel("A")
    aura_alpha = avatar_alpha.filter(ImageFilter.GaussianBlur(22))
    aura_alpha = ImageChops.multiply(aura_alpha, Image.new("L", avatar.size, 118))
    aura = Image.new("RGBA", avatar.size, (255, 157, 46, 0))
    aura.putalpha(aura_alpha)
    canvas.alpha_composite(aura, position)
    canvas.alpha_composite(avatar, position)

    frame = ImageDraw.Draw(canvas)
    frame.rounded_rectangle(
        (49, 49, 975, 975),
        radius=213,
        outline=(234, 171, 72, 210),
        width=7,
    )
    frame.rounded_rectangle(
        (63, 63, 961, 961),
        radius=199,
        outline=(64, 170, 255, 92),
        width=3,
    )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUTPUT, "PNG", optimize=True)
    print(OUTPUT)


if __name__ == "__main__":
    build_icon()

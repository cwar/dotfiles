#!/usr/bin/env python3
"""
Color-grade wallpapers to match Omarchy theme palettes.

Adjusts color temperature, tint, contrast, and saturation to make any
wallpaper feel cohesive with your current theme.

Usage:
    python3 wallpaper-filter.py input.jpg output.jpg --theme tokyo-night
    python3 wallpaper-filter.py input.jpg output.jpg --theme gruvbox --intensity 0.7
    python3 wallpaper-filter.py input.jpg output.jpg --tint "#7aa2f7" --warmth 0.2
    python3 wallpaper-filter.py --list   # Show available theme profiles
    python3 wallpaper-filter.py input.jpg output.jpg --theme catppuccin --preview

Requires: Pillow (pip install Pillow)
"""

import argparse
import subprocess
import sys

try:
    from PIL import Image, ImageEnhance, ImageFilter
except ImportError:
    print("Error: Pillow is required. Install with: pip install Pillow")
    sys.exit(1)


# Theme filter profiles
# (tint_hex, warmth, saturation, contrast, brightness, vignette_strength)
PROFILES = {
    "catppuccin":      ("#89b4fa", 0.05, 0.95, 1.02, 0.98, 0.15),
    "catppuccin-latte":("#1e66f5", -0.05, 0.90, 1.05, 1.10, 0.10),
    "tokyo-night":     ("#7aa2f7", -0.10, 0.90, 1.05, 0.92, 0.20),
    "nord":            ("#81a1c1", -0.15, 0.80, 1.00, 0.95, 0.15),
    "gruvbox":         ("#d65d0e", 0.20, 1.05, 1.08, 0.95, 0.20),
    "hackerman":       ("#39ff14", -0.20, 0.70, 1.20, 0.80, 0.35),
    "everforest":      ("#7fbbb3", 0.05, 0.85, 1.02, 0.95, 0.15),
    "kanagawa":        ("#7e9cd8", 0.00, 0.85, 1.05, 0.93, 0.20),
    "ethereal":        ("#7d82d9", -0.10, 0.80, 1.10, 0.85, 0.30),
    "matte-black":     ("#e68e0d", 0.10, 0.75, 1.15, 0.80, 0.30),
    "miasma":          ("#78824b", 0.15, 0.80, 1.05, 0.90, 0.25),
    "rose-pine":       ("#c4a7e7", 0.05, 0.85, 1.00, 1.05, 0.10),
    "ristretto":       ("#f38d70", 0.15, 0.90, 1.05, 0.92, 0.20),
    "osaka-jade":      ("#509475", -0.05, 0.85, 1.05, 0.90, 0.25),
    "vantablack":      ("#8d8d8d", 0.00, 0.50, 1.30, 0.70, 0.40),
    "white":           ("#6e6e6e", 0.00, 0.80, 1.10, 1.20, 0.05),
    "event-horizon":   ("#26bbd9", -0.10, 0.90, 1.08, 0.90, 0.25),
}


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))


def apply_tint(image: Image.Image, hex_color: str, strength: float) -> Image.Image:
    """Apply a color tint overlay."""
    r, g, b = hex_to_rgb(hex_color)
    tint_layer = Image.new("RGB", image.size, (r, g, b))
    return Image.blend(image, tint_layer, strength * 0.15)


def apply_warmth(image: Image.Image, warmth: float) -> Image.Image:
    """Shift color temperature. Positive = warmer, negative = cooler."""
    if abs(warmth) < 0.01:
        return image

    pixels = image.load()
    width, height = image.size

    for y in range(height):
        for x in range(width):
            r, g, b = pixels[x, y][:3]
            if warmth > 0:
                r = min(255, int(r + warmth * 30))
                b = max(0, int(b - warmth * 20))
            else:
                r = max(0, int(r + warmth * 20))
                b = min(255, int(b - warmth * 30))
            pixels[x, y] = (r, g, b)

    return image


def apply_vignette(image: Image.Image, strength: float) -> Image.Image:
    """Apply edge darkening vignette effect."""
    if strength < 0.01:
        return image

    width, height = image.size
    pixels = image.load()
    cx, cy = width / 2, height / 2
    max_dist = (cx**2 + cy**2) ** 0.5

    for y in range(height):
        for x in range(width):
            dist = ((x - cx)**2 + (y - cy)**2) ** 0.5
            factor = 1.0 - (dist / max_dist) * strength
            factor = max(0, factor)
            r, g, b = pixels[x, y][:3]
            pixels[x, y] = (int(r * factor), int(g * factor), int(b * factor))

    return image


def process_image(input_path: str, output_path: str, tint: str, warmth: float,
                  saturation: float, contrast: float, brightness: float,
                  vignette: float, intensity: float):
    """Apply all adjustments to an image."""
    img = Image.open(input_path).convert("RGB")

    # Scale all effects by intensity
    effective_warmth = warmth * intensity
    effective_sat = 1.0 + (saturation - 1.0) * intensity
    effective_contrast = 1.0 + (contrast - 1.0) * intensity
    effective_brightness = 1.0 + (brightness - 1.0) * intensity
    effective_vignette = vignette * intensity

    # Apply adjustments
    img = apply_tint(img, tint, intensity)
    img = apply_warmth(img, effective_warmth)
    img = ImageEnhance.Color(img).enhance(effective_sat)
    img = ImageEnhance.Contrast(img).enhance(effective_contrast)
    img = ImageEnhance.Brightness(img).enhance(effective_brightness)
    img = apply_vignette(img, effective_vignette)

    img.save(output_path, quality=95)
    print(f"Saved: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Color-grade wallpapers for Omarchy themes")
    parser.add_argument("input", nargs="?", help="Input image path")
    parser.add_argument("output", nargs="?", help="Output image path")
    parser.add_argument("--theme", help="Apply theme preset")
    parser.add_argument("--intensity", type=float, default=1.0,
                        help="Effect intensity (0.0-2.0, default: 1.0)")
    parser.add_argument("--tint", help="Custom tint color (#hex)")
    parser.add_argument("--warmth", type=float, default=0.0,
                        help="Color temperature (-1.0 cool to 1.0 warm)")
    parser.add_argument("--saturation", type=float, default=1.0, help="Saturation (0.0-2.0)")
    parser.add_argument("--contrast", type=float, default=1.0, help="Contrast (0.5-2.0)")
    parser.add_argument("--brightness", type=float, default=1.0, help="Brightness (0.5-2.0)")
    parser.add_argument("--vignette", type=float, default=0.0, help="Vignette strength (0.0-1.0)")
    parser.add_argument("--list", action="store_true", help="List available theme profiles")
    parser.add_argument("--preview", action="store_true", help="Open result in image viewer")
    args = parser.parse_args()

    if args.list:
        print("\nAvailable theme profiles:\n")
        print(f"  {'Theme':<20} {'Tint':<10} {'Warmth':>8} {'Sat':>6} {'Contrast':>10} {'Bright':>8} {'Vignette':>10}")
        print(f"  {'─'*20} {'─'*10} {'─'*8} {'─'*6} {'─'*10} {'─'*8} {'─'*10}")
        for name, (tint, warmth, sat, cont, bright, vig) in sorted(PROFILES.items()):
            print(f"  {name:<20} {tint:<10} {warmth:>+8.2f} {sat:>6.2f} {cont:>10.2f} {bright:>8.2f} {vig:>10.2f}")
        print()
        return

    if not args.input or not args.output:
        parser.error("Input and output paths are required (unless using --list)")

    if args.theme:
        if args.theme not in PROFILES:
            print(f"Unknown theme: {args.theme}")
            print(f"Available: {', '.join(sorted(PROFILES.keys()))}")
            sys.exit(1)
        tint, warmth, sat, cont, bright, vig = PROFILES[args.theme]
    else:
        tint = args.tint or "#ffffff"
        warmth = args.warmth
        sat = args.saturation
        cont = args.contrast
        bright = args.brightness
        vig = args.vignette

    process_image(args.input, args.output, tint, warmth, sat, cont, bright, vig, args.intensity)

    if args.preview:
        subprocess.run(["xdg-open", args.output])


if __name__ == "__main__":
    main()

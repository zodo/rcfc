#!/usr/bin/env bash
# Rasterize public/icon.svg into the PNG icons the manifest and iOS need.
# Re-run after changing the SVG; the PNGs are committed. Needs rsvg-convert
# (brew install librsvg).
#   icon-192/512.png      purpose "any": the rounded icon, transparent corners
#   icon-maskable-512.png purpose "maskable": full-bleed square; the OS crops it
#   apple-touch-icon.png  180px full-bleed (iOS rounds corners itself and
#                         turns transparency black)
set -euo pipefail
cd "$(dirname "$0")/../public"
full=$(sed 's/ rx="14"//' icon.svg)   # same art, square background
rsvg-convert -w 192 -h 192 icon.svg -o icon-192.png
rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png
rsvg-convert -w 512 -h 512 -o icon-maskable-512.png <<<"$full"
rsvg-convert -w 180 -h 180 -o apple-touch-icon.png <<<"$full"

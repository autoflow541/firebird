# Firebird — Accessibility (WCAG 2.2 AA)

The web surfaces (operator console, phone remote, mapping editor, stream overlay)
are built to **WCAG 2.2 Level AA**. Audited 2026-08-05 with an in-page
relative-luminance + geometry script across every surface.

## Criteria checked & status

| Criterion | What | Status |
| --- | --- | --- |
| **1.4.3** Contrast (Minimum) | Text ≥ 4.5:1 (large ≥ 3:1) | ✅ 0 failures (was 35 — muted grays raised to `#9092a0` / `--muted #a2a4ae`; blackout sub-labels lightened) |
| **1.4.11** Non-text Contrast | UI component/state contrast ≥ 3:1 | ✅ gold/red/green states on dark clear 3:1 |
| **2.4.7** Focus Visible | Every control shows focus | ✅ added global `:focus-visible` white ring; removed an `outline:0` |
| **2.4.11/2.4.13** Focus Not Obscured / Appearance (2.2) | Focus ring visible & adequate | ✅ 2px ring + 2px offset, high contrast on dark |
| **2.5.8** Target Size (Minimum) (2.2) | Pointer targets ≥ 24×24px | ✅ BPM field → 24px min-height; mapping corner handles 16→24px |
| **4.1.2** Name, Role, Value | Controls have accessible names | ✅ 0 failures |
| **1.3.1 / 3.3.2** Labels | Inputs labelled | ✅ all inputs have `<label>`/title |
| **1.1.1** Non-text content | Decorative elements hidden | ✅ brand mark / marquee `aria-hidden` |

## Method
Per-surface script: computes text vs. resolved-background contrast (WCAG relative
luminance), measures interactive element bounding boxes for target size, and checks
each control for an accessible name. Re-run after fixes → 0 contrast, 0 target, 0
name failures on operator/remote/mapping/stream.

## Notes
- The console is intentionally **dark** (correct for a front-of-house desk); the
  palette follows the Auto-Flow dark-surface tiers (white / `#d8d8d6` / `#b8b8b6`
  equivalents) rather than the white-page recipe.
- Semantic status colours are preserved for safety: red = blackout/danger, green =
  online, amber = waiting — not flattened to brand gold.
- The **projector** and **stream** outputs are display surfaces (not interactive).
- Electron runtime keyboard-operability should be spot-checked on the show machine
  (tab order, Space/Enter on custom controls) — the markup is native buttons/inputs
  so it inherits keyboard support.

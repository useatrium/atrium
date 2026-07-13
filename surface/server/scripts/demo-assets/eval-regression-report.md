# Eval regression: v0.12 → v0.13 (scanned-docs −3.1 F1)

**TL;DR** — the scanned-docs regression is fully explained by the new deskew
step. It over-crops pages rotated more than ~5°, cutting off margin text that
the extractor then never sees. Forms and tables improved; nothing else moved.

## What I did

1. Re-ran both eval suites pinned to the same corpus snapshot (`corpus@7f3d21`).
2. Diffed per-page F1 between versions; bucketed the deltas by every page
   attribute we track (rotation, DPI, source scanner, language, layout class).
3. Re-ran the 50 worst pages through v0.13 with the deskew step disabled.

## Findings

- **Rotation is the only attribute that separates the regressed pages.**
  Pages under 2° of rotation are *better* in v0.13 (+1.1 F1 median).
- The regression opens at **5–10°** (−3.1) and widens to **−6.5 at >15°**.
- With deskew disabled, the 50 worst pages recover to within ±0.4 of v0.12.
- The crop bounding box after deskew is on average **4.2% smaller** than the
  page content box on rotated pages — margin tokens fall outside it.

| split | pages | v0.12 | v0.13 | Δ |
|---|---|---|---|---|
| forms | 3,908 | 91.4 | 92.6 | **+1.2** |
| tables | 2,584 | 88.2 | 89.0 | **+0.8** |
| scanned-docs | 4,812 | 84.7 | 81.6 | **−3.1** |

## Recommendation

Keep deskew (the upright-page wins are real) but clamp the post-rotation crop
to the union of the detected content box and the original page box. A
threshold fix, not a rollback. Draft patch in `pipeline/deskew.py:141` — the
crop margin needs to scale with the rotation angle.

## Artifacts

- `f1-by-rotation.png` — the regression isolated by rotation bucket
- `evals-v0.13-scanned.csv` — per-page raw scores for the scanned split
- `apps/eval-dashboard` — interactive drill-down by split and rotation

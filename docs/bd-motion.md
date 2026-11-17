# Brown-dwarf proper motions: AllWISE 2010 → SPHEREx 2025–2026

Can SPHEREx see that a nearby brown dwarf has moved? This check takes
known T and Y dwarfs with large proper motions, finds them in real SPHEREx
frames, and compares where SPHEREx puts them with where their catalogued
motion says they should be, fifteen years after AllWISE saw them.

**Short answer.** Yes, for 14 of the 16. Each turns up where AllWISE plus its catalogued motion puts it in 2025–2026, between 9″ and 129″ from its 2010 position, with the residual under 0.8″ for 13 and 1.5″ for the fastest, WISE 0855−0714. The two that do not agree, WISE 1639−6847 and WISE 1541−2250, fail at the 2010 end: in both the AllWISE position is itself several arcseconds from where the motion carries the object back to. Objects with W2 brighter than about 13 are measured in single visits; the Y dwarfs at W2 ≈ 14 need a season stack of 15–40 frames. SPHEREx's own year of seasons, with no WISE data at all, gives the motion of Luhman 16AB, ε Indi B and 2MASS 1114−2618 to within 2 %, and of WISE 0855−0714 to 12 % (1.2σ).

Reproduce:

    node tools/measure-bd-motion.mjs                          # every target, ~5–7 min each the first time
    node tools/measure-bd-motion.mjs --only "WISE 0855-0714"  # one target
    node tools/measure-bd-motion.mjs --offline                # from .cache/bd-motion/ only

Results are written to `public/data/bd-motion.json`; the pure arithmetic is
tested in `tests/bd-motion.test.mjs`. Run on 16 Nov 2026 against IRSA SIA
(`spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3`, `spherex_qr3_deep`), the
public S3 mirror and the VizieR mirror at vizier.cfa.harvard.edu.

## Method

**Targets.** Sixteen objects from the 20 pc census of Kirkpatrick et al.
2021 (VizieR J/ApJS/253/7): T and Y dwarfs, plus the L/T binary Luhman 16AB,
with proper motions from about 0.6″/yr to 8.1″/yr and W2 brighter than
about 14.7. Proper motion and parallax are the paper's adopted ("best
measured") values. SCR 1845−6357B was left out: it sits 1″ from its M8.5
primary and SPHEREx would measure the pair.

**The 2010 position.** AllWISE (II/328/allwise), searched within 15″ of the
Kirkpatrick CatWISE position carried back to 2010.56, taking the nearest
source within 1 mag of the catalogue W2. Where AllWISE gives a motion-fit
position (`RA_pm`, `DE_pm`, at MJD 55400.0 = 2010.556) that is used; for
these fast movers it always did.

**Frames.** IRSA SIA, all four collections the page reads, at the expected
2026.0 position; D5 (3.8–4.4 µm) and D6 (4.4–5.0 µm) only, where T and Y
dwarfs are brightest. Each frame is cut out of the S3 mirror by the page's
own reader (`stamp.js`, with the pipeline's FLAGS mask) and resampled onto
one north-up grid per object, 2″ samples, at least 6′ across.

**Measurement.** In each image the brightest PSF-matched peak within 12″
(two detector pixels) of the predicted position is centroided with a
Gaussian-windowed centroid (σ = PSF FWHM 7.46″ / 2.355). SNR is the sum in a
nine-detector-pixel aperture against the frame's own robust sky noise
(`depth.js`), the same aperture the page's depth figure uses. This is done
for every single frame and for the mean of each season's frames per band
(frames less than 20 days apart).

**Astrometric check.** In every season stack, isolated Gaia DR3 stars to
G = 17 on the same grid, carried to the stack's epoch, are centroided the
same way. Their median offset from Gaia (typically 0.1–0.3″) is taken off the
brown dwarf's position when at least three are measured at SNR ≥ 20, and
the error of that median goes into the error budget. Otherwise a 0.5″ per
axis WCS error is assumed.

**Expected position.** AllWISE position + catalogue proper motion × (t −
2010.556) + the parallax displacement at t (Earth from the Sun's
low-precision coordinates; SPHEREx's own orbit, 700 km up, is ignored).
For a stack, the mean over its frames.

**Error budget** (per axis, added in quadrature): centroid error
(PSF σ × √2 / SNR), AllWISE position error, catalogue proper-motion error ×
elapsed time, the WCS term above, and half the parallax for what the
AllWISE average leaves of the parallax wobble.

**Verdict.** *Recovered*: detected at SNR ≥ 5, clearly away from the AllWISE
position (≥ 5 σ), and within half a detector pixel (3.1″) or within 3.44 σ
(the 99.7 % circle in two dimensions) of the prediction. `withinErrors` in
the JSON says which: a recovery outside the stated σ is marked in the table.
*Too faint*: no stack reaches SNR 5. *Disagrees*: detected, but further from
the prediction than both limits.

**SPHEREx on its own.** A weighted straight-line fit to the detected
season stacks (parallax removed), giving a proper motion that uses no WISE
data at all. The baseline is about a year, so it is coarse, but it is an
independent measurement.

## Results

One row per object: the season stack that speaks for it (the brightest of
the seasons that agree with the majority; see `headline` in the tool). Shifts
are from the AllWISE position, after the field-star correction where it was
applied. σ is the per-axis error budget above. "SPHEREx-only μ" is the fit
to SPHEREx's own seasons, about one year of baseline, with its error scaled
by the scatter of the seasons about the line.

| object | type | μ, ″/yr | W2 | band, season | n | SNR | expected ″ | measured ″ | PA exp / meas | residual ″ | σ ″ | field stars | SPHEREx-only μ, ″/yr | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| WISE 0855−0714 | Y4 | 8.15 | 13.8 | D5 2026-05 | 15 | 20.4 | 129.1 | 129.6 | 275° / 275° | 1.46 | 0.37 | 7 | 7.19 ± 0.78 at 278° | recovered (outside stated σ) |
| Luhman 16AB | L7.5 | 2.79 | 7.3 | D5 2026-06 | 27 | >1000 | 44.9 | 45.0 | 278° / 278° | 0.23 | 0.27 | 13 | 2.81 ± 0.21 at 276° | recovered |
| ε Indi Ba/Bb | T2.5 | 4.71 | 9.5 | D5 2025-10 | 23 | >1000 | 71.6 | 71.3 | 123° / 122° | 0.78 | 0.19 | 4 | 4.75 ± 0.09 at 122° | recovered (outside stated σ) |
| WISE 1639−6847 | Y0 | 3.16 | 13.5 | D5 2026-03 | 18 | 23.7 | 49.4 | 43.8 | 169° / 168° | 5.69 | 0.25 | 11 | 3.38 ± 0.36 at 174° | disagrees |
| 2MASS 1114−2618 | T7.5 | 3.04 | 12.3 | D5 2025-05 | 14 | 114.1 | 45.2 | 45.6 | 263° / 263° | 0.43 | 0.16 | 7 | 2.98 ± 0.16 at 267° | recovered |
| WISE 0254+0223 | T8 | 2.57 | 12.8 | D5 2026-01 | 18 | 61.1 | 39.8 | 39.9 | 85° / 85° | 0.18 | 0.52 | 2 (not applied) | 2.42 ± 0.51 at 84° | recovered |
| WISE 0410+1502 | Y0 | 2.42 | 14.1 | D5 2026-02 | 18 | 14.2 | 37.6 | 38.1 | 157° / 156° | 0.62 | 0.41 | 9 | 2.47 ± 0.50 at 149° | recovered |
| WISE 1405+5534 | Y0.5 | 2.35 | 14.1 | D5 2026-05 | 23 | 18.2 | 37.3 | 37.1 | 276° / 275° | 0.51 | 0.31 | 5 | 2.33 ± 0.37 at 268° | recovered |
| 2MASS 0415−0935 | T8 | 2.28 | 12.3 | D5 2026-08 | 22 | 116.7 | 36.8 | 36.9 | 76° / 76° | 0.11 | 0.51 | 0 (not applied) | 2.28 ± 0.51 at 70° | recovered |
| Gl 570D | T7.5 | 2.01 | 12.1 | D5 2026-07 | 18 | 107.5 | 32.0 | 31.7 | 149° / 149° | 0.40 | 0.15 | 6 | 2.27 ± 0.18 at 141° | recovered |
| WISE 1741+2553 | T9 | 1.56 | 12.3 | D5 2026-08 | 18 | 108.4 | 25.0 | 25.4 | 199° / 199° | 0.39 | 0.17 | 8 | 2.43 ± 0.72 at 236° | recovered |
| WISE 1506+7027 | T6 | 1.59 | 11.3 | D5 2026-04 | 19 | 338.7 | 25.1 | 25.1 | 312° / 311° | 0.10 | 0.18 | 5 | 2.03 ± 0.31 at 315° | recovered |
| 2MASS 0939−2448 | T8 | 1.19 | 11.6 | D5 2025-05 | 18 | 174.4 | 17.5 | 17.5 | 152° / 152° | 0.04 | 0.15 | 7 | 1.89 ± 0.47 at 139° | recovered |
| UGPS 0722−0540 | T9 | 0.97 | 12.2 | D5 2026-04 | 18 | 86.8 | 15.5 | 15.3 | 291° / 291° | 0.22 | 0.18 | 11 | 0.36 ± 0.46 at 300° | recovered |
| WISE 1541−2250 | Y1 | 0.91 | 15.1 | D5 2025-07 | 18 | 19.5 | 13.8 | 4.3 | 264° / 325° | 12.28 | 0.29 | 4 | 0.94 ± 4.57 at 241° | disagrees |
| WISE 0350−5658 | Y1 | 0.61 | 14.7 | D5 2025-06 | 18 | 10.6 | 9.0 | 9.1 | 200° / 202° | 0.34 | 0.69 | 2 (not applied) | 1.95 ± 0.75 at 161° | recovered |

Every season, both bands, single-frame counts and the frames each object
read are in `public/data/bd-motion.json`.

**What it shows.**

- **14 of 16 recovered.** Shifts from 9″ (WISE 0350−5658, 1.5 detector
  pixels) to 129″ (WISE 0855−0714, 21 pixels) come out within half a pixel
  of the prediction, 13 of them within 0.8″. The direction agrees to 1–2°
  wherever the shift is more than a few pixels.
- **In every season, not just the best one.** For the 14, every detected
  season stack agrees with the prediction except one. A single D6 stack of
  WISE 1405+5534 (May 2026) locked onto something brighter 15″ away, and
  the verdict set it aside (`seasonsSetAside`).
- **Single visits are enough for the brighter half.** The objects with W2
  brighter than about 13 are measured at 5σ in nearly every single frame,
  and recovered in 85–161 frames each. The Y dwarfs at W2 ≈ 14 are not.
  WISE 0410+1502 reaches 5σ in 1 of 107 single frames, and WISE 0350−5658
  in 2 of 132. Those need a season stack: SNR 10–18 from 15–40 frames.
- **D5 is the better band.** In every case the brightest stack was D5
  (3.8–4.4 µm), not D6 (4.4–5.0 µm), although D6 is the closer match to
  WISE W2.
- **SPHEREx's WCS is good to a few tenths of an arcsecond.** Where three or
  more Gaia stars were measured in a stack, the median offset from Gaia was
  under 0.25″ on each axis and the scatter about it 0.05–0.4″. The correction is small. It
  is applied so that the result does not depend on it.
- **SPHEREx alone sees the motion.** From its own seasons, with no WISE
  data, the fit gives the right speed and direction for the fast movers:
  Luhman 16AB 2.81 against 2.79″/yr, ε Indi B 4.75 against 4.71,
  2MASS 1114−2618 2.98 against 3.04. The fit is uncertain by 0.1–0.8″/yr.
  Below about 1.5″/yr that is a large fraction of the motion: WISE 1741,
  UGPS 0722 and WISE 0350 come out 1.2–1.8σ from their catalogue values.

**What did not work, and why.**

- **WISE 1639−6847: disagrees.** All eight detected season stacks put it
  4–6″ short of the prediction, along the direction of motion. SPHEREx's own motion
  (3.38 ± 0.36″/yr at 174°) agrees with the catalogue (3.16″/yr at 170°).
  So the offset is fixed, not growing. It points at the 2010 anchor, not
  at the SPHEREx positions. The AllWISE source matched is 0.7 mag fainter in
  W2 than the catalogue value and sits 4.2″ from where the CatWISE position
  carries back to. At b ≈ −15° the field is crowded. The likely cause is a
  blend in AllWISE, though this check cannot show it. Not counted as a
  recovery.
- **WISE 1541−2250: disagrees.** The AllWISE source matched is 7.1″ from
  where the CatWISE position carries back to 2010, and its W2 is 0.6 mag
  off the catalogue's. The D5 stacks find a source 4″ from that AllWISE
  spot, probably a field source, not the brown dwarf. The D6 stacks find
  the brown dwarf 0.9–1.8″ from the CatWISE-based prediction, but 7–8″
  from the AllWISE-based one. Against AllWISE, as this check is defined, it
  does not agree.
- **WISE 0855−0714 and ε Indi Ba/Bb are recovered, but outside their stated
  errors** (1.5″ and 0.8″ against σ = 0.37″ and 0.19″). For WISE 0855 the
  AllWISE motion fit has to describe 8″ of motion inside its own year of
  scans, and the AllWISE and CatWISE positions already disagree by 3.7″
  carried to the same epoch. ε Indi Ba/Bb is an unresolved binary with a
  catalogue position that is not from CatWISE. Neither error is in the
  budget, so the budget is too small for these two. The table says so
  rather than widening it after the fact.

## Limitations

- **The 2010 anchor dominates where it fails.** Both failures and both
  out-of-σ recoveries come down to the AllWISE position, not to SPHEREx.
  AllWISE measures a fast mover from scans spread over a year, and blends it
  with whatever it passes. The CatWISE-based comparison is in the JSON as
  `residualCatwise` for anyone who wants the other anchor.
- **The search is local.** The brown dwarf is looked for within 12″ of
  where it is expected. That is what makes a Y dwarf at SNR 10 measurable at
  all. It also means the check cannot find an object that is somewhere else
  entirely. Two things guard against a false recovery: the 5σ detection,
  and the requirement that the object be clearly away from its 2010
  position. The guard is not proof against a background source that
  happens to sit at the predicted spot.
- **The error budget is approximate.** The centroid term is a
  background-limited formula. The 0.5″ WCS term is assumed, not measured,
  where too few Gaia stars were usable (WISE 0254, 2MASS 0415, WISE 0350).
  Half the parallax is allowed for what the AllWISE average leaves in.
- **Saturation.** Luhman 16AB and ε Indi B are bright enough that some
  frames saturate at the core (15 and 2 single frames). Their SNRs, in
  the thousands, are formal. The windowed centroid of a symmetric
  saturated core is still central, and their residuals (0.2″ and 0.8″) show
  no sign of a problem.
- **Binaries.** Luhman 16AB (about 1″ apart) and ε Indi Ba/Bb (0.7″)
  are unresolved at 6.15″ pixels. What is measured is the light centre of
  the pair, which moves with the system.
- **One year of SPHEREx.** The seasons run from May 2025 to September 2026.
  The SPHEREx-only motions will tighten as more seasons arrive. The
  AllWISE comparison will not change much: it is already limited by 2010.
- **Selection.** These are among the brightest, fastest brown dwarfs
  known, chosen so that the test could succeed. Fainter or slower objects
  will be harder. For a moving object at W2 ≈ 15, a season stack is not
  enough.

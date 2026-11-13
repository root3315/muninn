# Muninn

**A public-facing viewer for NASA SPHEREx that shows how a patch of sky changes between visits.**

NASA Space Apps Challenge 2026 — *Planet X and SPHEREx* · team **Yggdrasil**

**Live: <https://muninn.mydevbox.xyz>** · open *(152) Atala* under the search and press Space.
**The talk, eight slides: <https://muninn.mydevbox.xyz/talk.html>** — its first slide reads real frames
from the archive as you watch.

Three things it shows on real data:

- **It finds and names a mover.** On 25 Dec 2025 one dot appears in the Atala field at SNR 533 and in
  no other visit. SkyBoT names it at that exposure's own timestamp: asteroid (152) Atala.
- **It refuses a false discovery.** A second "flash" on 6 Jul 2025 (SNR 192) was a single pixel the
  SPHEREx pipeline had already flagged as a cosmic ray. Muninn reads the `FLAGS` plane and masks it.
- **It measures how far SPHEREx is from Planet Nine.** 17.60 AB per visit, from delivered detector
  pixels; the prediction is V 22–25. That is 1.5–4.5 mag short even with 200 visits added, and the
  page says so.

Against the challenge: all five named test targets open in one press · WISE and Gaia identify a
marked source by catalogue, and their catalogue positions can be overlaid on the plate, Gaia's
moved to the date of each visit (no image panel yet) · a marked source gets a spectrum on demand, one
point per band at the wavelength the file gives for its detector pixel.

---

Odin's two ravens flew out over all the worlds each day and came back at evening to
tell him what had changed. The second one was called Muninn — Memory. That is the whole
job here: remember what a piece of sky looked like last time SPHEREx passed over it, and
show you what is different now.

SPHEREx photographs the entire sky in 102 near-infrared bands roughly twice a year. Most
positions have therefore been photographed on several separate dates. Stars stay put.
Asteroids, comets and anything else bound to the Sun do not. Blink two visits against
each other and the movers stop hiding — the same trick Clyde Tombaugh used to find Pluto
in 1930, here on an all-sky survey in 102 infrared bands.

---

## Run it

```bash
node server.js          # Node 18+, no dependencies to install
```

Then open <http://127.0.0.1:5173>.

The server does two things: it serves the page, and it relays the calls to NASA services
that send no CORS headers, which the browser is therefore not allowed to make itself:
IRSA's frame index, IRSA's catalogue service (TAP) and JPL's small-body identification.
Image data never passes through it.

```bash
npm test                # 65 offline tests: a synthetic FITS through the whole pipeline, and more
npm run bake            # refresh the pre-resolved opening fields (optional)
npm run probe           # check the WCS round-trip against a live SPHEREx header
node tools/verify-mover.mjs 13.4194 3.8459 0.15   # the photometry check below
```

### Showing it to someone, right now

A Cloudflare Quick Tunnel puts the machine you are already running on behind a
public HTTPS address, with no account and no deploy:

```bash
cloudflared tunnel --url http://127.0.0.1:5173
```

It prints a `*.trycloudflare.com` address that serves whatever `server.js` is
serving, live. The address lasts as long as the process and is different every
time, so it is right for a demo and wrong for anything you want to link to
twice.

### Putting it on the web

The site is the static `public/` directory plus one server-side function, so it
deploys to Cloudflare Pages as-is:

```bash
npx wrangler login              # once, in a browser
npm run deploy                  # wrangler pages deploy
```

`wrangler.toml` points Pages at `public/`, and `functions/api/search.js` is the
IRSA relay ported to the Workers runtime. Both import the same VOTable parser, but
the port runs under tighter limits (a 20 s wait on IRSA against 150 s, 400 rows per
collection against 500), so a position IRSA has not seen before can time out there.
The live site runs `server.js`. The catalogue and small-body relays (`/api/tap`,
`/api/sbident`) exist only there; on Pages the catalogues come from VizieR alone and
known asteroids from SkyBoT alone.
Pixels are not involved either way: the browser reads them straight from the S3
mirror.

The ten ready fields never reach that function at all, because their frame
indexes ship with the page and are checked first. So the deployment degrades
well: if the edge function is throttled or IRSA is down, the presets still open
and only arbitrary coordinates stop resolving.

`public/_headers` names every origin the page is allowed to reach — the S3
mirror, IRSA, CDS (Sesame, SIMBAD, VizieR), SkyBoT — and nothing else. `server.js`
reads the same file and sends the same policy, so the rule is written once.

---

## What you can do with it

- **Open a field** by object name (`M51`, `Vega`, `Betelgeuse` — resolved through SIMBAD),
  by coordinates in decimal or sexagesimal, by one of the ten ready fields, or at
  random.
- **Blink** every visit in sequence, **wipe** two of them against each other with a
  draggable divider, or take their **difference** — cyan where A is brighter, amber where B
  is, the same colours as the A and B chips.
- **Stack a season.** SPHEREx comes back to a field in seasons — a few visits over a week
  or two, then nothing for half a year. The stack adds one season's visits in one band
  (each pixel takes the middle of three values, or drops the brightest of four or more,
  which takes out a missed cosmic ray or an asteroid passing once) and says how deep that
  gets; ← → steps from season to season. Each visit is first put on the same sky level:
  the zodiacal background changes between visits by more than the noise, and left in,
  "drop the brightest" dropped the visit with the brightest sky instead of the cosmic ray.
- **Mark a spot** by clicking it. Muninn re-measures that exact sky position in every
  loaded visit — position, AB magnitude, a bar per visit — classifies what it finds
  (fixed · intermittent · moving · present once),
  and checks it against the IMCCE catalogue of known solar-system objects at the exact
  moment of each exposure.
- **Adjust the stretch** — asinh, log, square root, linear — and the white point, because
  a single frame spans four orders of magnitude between the zodiacal background and a
  bright star.
- **Choose per-visit or shared brightness scaling.** Per-visit stretching makes movement
  easy to see and hides brightness change. Shared scaling does the opposite. The tool says
  so rather than quietly picking one.
- **Share the view** — the URL carries the field, the width, the band and the language.
- English and Russian, switchable at any time.

Keyboard: <kbd>Space</kbd> play/pause, <kbd>←</kbd> <kbd>→</kbd> step between visits,
<kbd>H</kbd> give the sky the whole window.

### The challenge's own test targets

The challenge names five fields to test a tool like this on. Each opens in one press
from the line *Challenge targets* under the search, or by URL, for example
`/#ra=133.7951&dec=-7.2451&fov=0.3&band=D6`. Their frame indexes ship with the
page, like the original five.

| target | why it is a test | what to do in Muninn | archive, at bake time |
| --- | --- | --- | --- |
| Barnard's Star | fastest proper motion in the sky, 10.3″/yr | blink; mark the star and read the verdict | 10 D2 visits over 212 days |
| ε Indi B | a pair of brown dwarfs beside their star, ε Indi A | blink in D2, then D6 | 22 D2 visits over 371 days |
| WISE 0855−0714 | the coldest known brown dwarf, 8.1″/yr | opens in D6, the only band it is bright in. At W2 ≈ 13.9 (about 17.2 AB) it sits below the one-visit limit in D6 (16.7 AB): a test of the Stack, not of a single frame | 17 D6 visits over 370 days |
| RW Aurigae | a young, irregular variable star | switch to shared scaling and blink | 10 D2 visits over 182 days |
| R Draconis | a Mira variable near the north ecliptic pole | shared scaling; step season to season | 63 D3 visits over 392 days |

For the two variables, a mark reports an AB magnitude per visit, summed over a 3×3-pixel
aperture (a steady 12th-magnitude star in the Atala field holds within 0.3 mag over ten
visits). What it cannot do is hold the wavelength still: each visit puts the source at a
different wavelength inside the band. A Mira's swing of several magnitudes shows through
that; a few tenths do not, and the mark says so.

What the motion test can and cannot show is stated in *What this can and cannot find*
below: over a baseline of about a year, a star has to move more than one 6.15″ detector
pixel to be seen to move. Over the 212 days of its baked D2 visits Barnard's Star covers
6.0″, a hair under one pixel, so a mark on it reads *fixed*: an honest answer, and the
reason the threshold is stated. It crosses the pixel once the baseline passes 218 days.

### NASA data and services used

| what | from | used for |
| --- | --- | --- |
| SPHEREx Level-2 spectral images (Data Release 1 and Quick Release 3) | NASA/JPL-Caltech · IPAC/IRSA, via the AWS Open Data mirror `nasa-irsa-spherex` | every pixel on screen, read by HTTP range request |
| SPHEREx frame index | IRSA Simple Image Access v2, collections `spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3`, `spherex_qr3_deep` | which frames cover a position, when, and in which band |
| SPHEREx `FLAGS` plane | the same files | masking cosmic-ray hits and bad pixels before anything is measured; the caption of every frame says how many pixels that was |
| AllWISE Atlas images, W1 and W2 | NASA WISE, through IRSA SIA (`wise_allwise`) and an IBE cutout, relayed by `/api/wise` | the field as WISE saw it in 2010–2011, resampled onto the same north-up grid and shown as B of the wipe; a star that moved in fifteen years sits on either side of the divider at different places. The idea is WiseView's, the blink tool the challenge names as a model |
| AllWISE W1/W2 | NASA WISE, through IRSA TAP (`allwise_p3as_psd`), raced against CDS VizieR | identifying a marked source at 3.4 and 4.6 µm; an overlay of AllWISE positions on the plate (epoch about 2010.5, not moved) |
| CatWISE2020 | NASA WISE and NEOWISE, through IRSA TAP (`catwise_2020`) | whether a marked source moves: a proper motion from ten years of WISE, said only at five times its error. The catalogue the coldest brown dwarfs, WISE 0855−0714 among them, were found in |
| 2MASS | NASA/IPAC 2MASS Point Source Catalog, through IRSA TAP (`fp_psc`), raced against CDS VizieR | J, H and K of a marked source, the near infrared SPHEREx works in |
| Gaia DR3 | ESA Gaia, through IRSA TAP (`gaia_dr3_source`), raced against CDS VizieR | identifying a faint marked star, and whether Gaia saw it vary; an overlay of Gaia positions on the plate, carried by proper motion from J2016.0 to the date of the visit |
| Known solar-system objects | NASA/JPL Small-Body Identification (`sb_ident`), merged with SkyBoT (IMCCE) | naming asteroids and comets at the moment of each exposure; either service alone is enough |

### When a new SPHEREx release lands

SPHEREx data arrive in releases, each published by IRSA as a new SIA collection on the
same S3 mirror. Nothing in the page stores pixels, so new data need no rebuild:

1. Arbitrary positions see a new release as soon as its collection name is added to
   `public/js/release.js`. That one list feeds the local relay, the edge function and
   the bake script.
2. `npm run bake` refreshes the frame indexes that ship with the page, so the ten
   ready fields open with the new visits too.
3. `npm test`, then deploy. The relay caches IRSA answers for twelve hours, so new
   frames added to an existing collection reach arbitrary positions within half a day;
   the ten baked fields see them at the next bake.

### Nothing sits on the picture

The layout is one grid of four cells — top bar, rail, sky, dock — and no control
is ever drawn over the frame. An earlier version floated the panels on the sky
and faded them when the pointer went still; that was the wrong fix. A panel in
front of the thing you came to look at is still in front of it, however faint.
<kbd>H</kbd> drops the other three cells so the picture takes the whole window,
leaving only its date and the scale bar — a real change of size rather than a
hiding of overlays.

### Colour

The interface is one hue family — a dark navy ground and a single cyan signal
colour — plus a second, amber hue used only where data needs a sign. Every text
pairing that ships is checked rather than assumed (`public/css/tokens.css`):
ink 16.8:1 on the ground, secondary text 6.3:1, the cyan accent 9.3:1, the text
on an accent fill 9.6:1.

The image ramps live in the same token layer and are verified as data, not
decoration: each sequential ramp rises in luminance across all 256 entries, so
the tint never reports a brightness the pixels do not have, and the diverging
ramp used for the difference view has its two arms solved numerically to equal
weight, so "brighter in A" and "brighter in B" are comparable rather than one
of them simply louder. Each arm wears the colour of its own chip: cyan for A,
amber for B. Chroma is held down in the bottom third of every ramp: that is
where a sky background lands, and a saturated floor turns the survey's own
noise into a coloured wash across the frame. The day theme runs every ramp the
other way, as a photographic negative — black stars on clear glass, the way
plates were blinked in 1930.

---

## How it works

### Reading 70 MB files a few megabytes at a time

A SPHEREx Level-2 spectral image is a ~70 MB multi-extension FITS file. Most of that is
the PSF cube; the flux plane is 2040 × 2040 float32 near the front. Ten visits would be
700 MB, which is not a web page.

The public AWS Open Data mirror `nasa-irsa-spherex` answers HTTP Range requests with
`Access-Control-Allow-Origin: *`. So the browser:

1. Reads the first 64 KB and parses the FITS headers (`public/js/fits.js`).
2. Builds the WCS — `RA---TAN-SIP` with third-order forward **and** inverse SIP
   coefficients (`public/js/wcs.js`).
3. Works out which detector rows the requested field actually lands on, and fetches only
   those — one to three megabytes, depending on the field and the roll, instead of 70.
4. Fetches the same rows of the `FLAGS` plane and blanks every pixel the SPHEREx
   pipeline itself marked as not having seen the sky — a cosmic-ray jump caught up the
   ramp (`TRANSIENT`), an onboard processing error, dead, hot and cold pixels, lost data,
   persistence — before anything is resampled or measured. That doubles the bytes, and it
   is the difference between a search and a cosmic-ray collection (see the Atala field
   below). Bright-star saturation, `OUTLIER` and `SOURCE` are left alone, because
   real sources carry them too.

A ten-visit field costs a few tens of megabytes of the ~680 MB those files occupy at the
archive. The page prints the exact number as you use it.

### Making the frames comparable

SPHEREx rolls between visits. In the Atala field below, the December frames sit at a roll
of −158° and the July frames at +22° — the raw pixel grids are 180° apart, so blinking
them directly would show nothing but rotation.

Every visit is therefore resampled onto one shared north-up tangent plane centred on the
target before it is displayed (`public/js/stamp.js`). Sky positions are mapped through the
full TAN + SIP inverse and sampled bilinearly, with the nearest valid neighbour used
around masked pixels. `npm run probe` checks the forward/inverse round trip against a live
header — worst case 0.015 px across the full 2040 × 2040 detector.

### Cutting the frame into districts

Blinking ten frames and hoping is not a search. A person holds maybe three
places in their head at once; a frame has a hundred thousand pixels. So the
frame is cut into a 5 × 4 grid of numbered sectors, and every sector is scored
in every visit by one question — how unusual is this visit, for this sector?

    score = (peak in this visit − median peak across visits) / noise

A star that is always there scores zero, because it is in the median. Something
that appeared, brightened or moved in scores high. The noise is the larger of
the sector's own spread of peaks and the frame's pixel noise: without that
second floor a flat sector divides by almost nothing and reports scores in the
thousands, which is a bug that looks like a discovery.

The result is a matrix of sectors against visits, lit where a sector stopped
looking like itself. It is drawn as a 5 × 4 signature under each frame of the
run, in the same layout as the picture. Pressing a lit cell goes to that visit and lights
that sector on the picture. That link is the only reason the matrix earns its
space: it has to hand you somewhere to look.

Checked against a synthetic field with a steady star in one sector and a
one-visit transient in another: the steady star scores 0.0 in every visit, the
transient is the single standout.

### Hunter X: reading a distance out of slowness

Almost all of the apparent motion of a distant body is not the body moving. It
is the Earth moving while the body sits still — parallax. At opposition the
body is d − 1 AU away and the Earth outruns it by its own orbital speed less the
body's, which gives

    rate ≈ 2π · 206265 / (d + √d)   arcseconds per year   (d heliocentric, AU)

That inverts to a distance, and sorts the solar system by depth:

| | apparent rate at opposition |
| --- | --- |
| main belt, 2.7 AU | ~34″ per hour |
| Jupiter trojans, 5.2 AU | ~20″ |
| Neptune, 30 AU | ~4″ |
| Sedna near aphelion, ~940 AU | ~0.15″ |
| Planet X, 400–800 AU | 0.18–0.35″ |

For a distant body opposition is where the motion is fastest. Anywhere else the
same body shows less, and less reads as farther — so a distance from a measured
rate is an upper bound, and the interface says "no farther than". An earlier
version used 2π · 206265 / d and called the bound a floor; (152) Atala, at 3 AU,
came out as "no nearer than 7 AU".

SPHEREx does not look at opposition, though: it looks about 90° from the Sun.
There the Earth moves along the line of sight and what is left is the body's own
orbital motion, 2π / d^1.5 radians a year — which inside 2.62 AU is the *faster*
of the two. So the bound is the larger of the two distances a rate allows
(`distanceCeilingAU`), or a body at 2.2 AU would read "no farther than 1.9".

So an asteroid streaks and anything out where the predictions live barely
crawls. Once the last visit is in, Hunter X takes the places the matrix flagged —
the strongest twelve — measures what is at each position in every visit, keeps
whatever moves, and sorts by slowness.
The rate-to-distance arithmetic round-trips exactly (`public/js/hunt.js`).

Three guards stand between that and a false discovery, and all three were added
because the first version tripped over them:

- **A rate has to be distinguishable from zero.** The first run reported a
  candidate at 0.00″ per hour and therefore "no nearer than 74 362 AU", which is
  not a discovery but a division by almost nothing.
- **A line needs enough points that it could have failed to fit.** Two
  detections fit a straight line perfectly, so the scatter is zero and any
  significance test passes on nothing at all. Four is the minimum.
- **The floor under the astrometry is the detector's own pixel.** Resampling
  finely does not create information: a body that crossed less than one 6.15″
  pixel across the whole baseline has not been seen to move, whatever slope the
  fit returns. A mark needs one pixel of motion to be called moving; Hunter X
  ranks a candidate only past three (18.45″). That rejected a second false
  candidate that had crept in at 17.7″ of total motion.

What survives is worth stating precisely. Over a 369-day baseline the astrometry
reaches 0.002″ per hour, and Planet X needs 0.18–0.35″, so precision is not the
obstacle. Two things are. **The brightness is out of reach** — 17.60 AB per
visit against a prediction of V 22–25. And the tracker as built measures each
place in a fixed box about ±12″ across, while a body at 400–800 AU shifts by
8–17′ between SPHEREx's two visits a year: it follows a mover within one season,
not across seasons. Linking the seasons at a trial distance is the next step.
That is a far more useful account than either "we found it" or "we cannot look".

### What this can and cannot find

The challenge is named for Planet X, so the first honest thing to establish is
whether SPHEREx could see it. That is one number, and `tools/sensitivity.mjs`
measures it from delivered pixels rather than quoting a mission page: the robust
sky noise of the detector's own pixels (after the pipeline's `FLAGS`), converted
to flux through the 6.15″ pixel's solid angle, summed over a 3×3 aperture, stated
as a 5σ point-source limit. An earlier version took the noise from the resampled
grid, which bilinear interpolation smooths, and came out about 0.4 mag too deep.

| | 5σ point source |
| --- | --- |
| one visit | **17.60 AB** (16.68 in D6 to 18.04 in D4) |
| 10 visits, if coadded | 18.85 AB |
| 100 visits | 20.10 AB |
| 200 visits, deep field | 20.47 AB |

Planet Nine is predicted at V ≈ 22–25. The range is from Linder & Mordasini (2016,
A&A 589, A134), who model the planet as a small Uranus and give, near aphelion, V = 24.3,
23.7, 23.3 and 22.6 for 5, 10, 20 and 50 Earth masses in reflected light. It is the faint
case: the same paper puts a 10-Earth-mass planet at 700 AU at V = 21.7, and Brown &
Batygin (2021, AJ 162, 219) argue it may be closer and brighter than first thought. Even
at V = 21.7 the deepest stack here is more than a magnitude short. Even coadding two hundred deep-field
visits leaves us short by 1.5 magnitudes at the bright end of that range — a
factor of 4 in flux — and 4.5 magnitudes at the faint end, a factor of 65. The
prediction is in V and SPHEREx works at 0.75–5 µm: for a grey, sunlike reflector
the two are within a few tenths of a magnitude, and a cold, methane-rich body
reflects less in the infrared, which only widens the gap.

**So this tool does not find Planet Nine, and says so on screen.** Every field it
opens reports the depth its search works at — one visit, since the automatic search
measures visit by visit — and what a coadd would add, computed from that field's own
noise by `public/js/depth.js` — the same module the
command-line tool uses, so the number in the interface and the number here cannot
drift apart.

What is left is a real search rather than a consolation prize:

- **Slow movers brighter than ~17.6 AB per visit.** SPHEREx has only just begun
  delivering, and we know of no published moving-object search of the Quick
  Release data.
- **Season stacks, and the jump between them.** SPHEREx looks about 90° from the Sun,
  where the Earth's own motion is mostly along the line of sight, so a distant body
  near the ecliptic barely moves inside a season. (Away from it the reflex motion grows
  with the sine of the ecliptic latitude: at 20° a body at 500 AU crosses about four
  pixels in eleven days, at the poles about thirteen, and a plain stack smears it.)
  Measured for the Atala field's eleven-day December
  season: at 500 AU the parallax and the body's own orbit move it at most ~1.7 detector
  pixels (at 300 AU, about three). Adding the season's visits therefore keeps a Planet X
  -distance body sharp and gains √n in depth — four visits, about 0.6 mag — and between
  seasons the same body at 500 AU jumps 13.6′. Blinking season stacks is the deep version
  of the blink. We measured shifting each visit along a trial distance before adding
  (shift-and-stack) too, and inside a season at these distances it is the same pixel or so
  as no shift, so the stack does not pretend otherwise.
- **An upper limit.** A null result over a stated area at a stated depth is a
  constraint, not a failure. The depth panel keeps a count of the fields examined
  in this browser and the square degrees they cover, so the coverage is a record
  rather than an impression.
- **A spectrum for anything found.** This is the part no other survey offers.
  Checking the real observing schedule of one field: on 25 Dec 2025 SPHEREx took
  it in D2, D3, D5 and D6 — four bands the same day — and the best three-day
  window covers all six, 0.75–5.01 µm. D4 (2.40–3.85 µm) and D5 (3.81–4.43 µm)
  straddle the 3 µm water-ice band. A mark now reads one exposure per band and
  plots flux density against the wavelength each exposure saw the source at
  (the file's `WCS-WAVE` table at its detector pixel): six points, not the full
  102-channel spectrum, which needs every exposure of a visit rather than one.

And what it will not find: **brown dwarfs and nearby stars by their motion**, with a few
exceptions. A star has to cross a 6.15″ pixel over the ~1.2-year baseline to be seen to
move, which takes a proper motion above about 5″ a year. Barnard's star (10.3″/yr) and
the coldest known brown dwarf, WISE 0855−0714 (8.1″/yr), qualify; a typical nearby brown
dwarf moves 0.1–1″ a year and does not. Its parallax, under one arcsecond, does not
show either.

### Showing all of the frame

The reprojected field is drawn to *fit* its panel, never to fill it. Filling
means scaling until the shorter side is covered and pushing the rest off the
edges — sky that was fetched, reprojected and then thrown away. The grid is
built at the panel's own aspect ratio so the two normally agree exactly; when a
drawer opens and they briefly disagree, the leftover is the well, which is the
same colour as the bottom of every image ramp and so cannot be seen.

Getting that right meant fixing the grid too. Flooring its height — which is
what an earlier version did to avoid a degenerate strip — built a grid squarer
than the panel, and a quarter of it then sat outside the visible area. Holding
the aspect and raising the width instead costs nothing and puts 33% more real
samples across the same screen height.

The field-size control sets the *width*; the height follows from the shape of
the panel, so the readout names both. That is why the presets carry their own
size: an asteroid is a point and a galaxy is not.

SPHEREx samples the sky at 6.15″ per pixel, so an 18′ field holds about 176 real pixels
across — however wide the screen is. Resampling that onto a 1500-pixel grid invents
nothing and turns every bright star into a square plateau, the tent shape a bilinear
filter leaves around a single hot pixel.

So the shared tangent grid is cut to about 2.5 samples per detector pixel, and the last
magnification up to screen size is left to the browser's own high-quality resampler. The
same change makes the aperture photometry honest: a 5-pixel box on the grid is now a few
detector pixels wide rather than a fraction of one.

The black point matters just as much. A flat low percentile leaves the whole sky
background sitting above black, and the asinh stretch then lifts that noise into visible
mottling — which reads as a blurred picture rather than a faint one. The cut is placed
relative to the noise instead: the median plus one standard deviation, where sigma comes
from the lower half of the distribution, which stars cannot contaminate.

### Saying only what the pixels support

Clicking a spot measures it in every visit: local background from an annulus, peak-finding
inside the box, then a flux-weighted centroid. A detection needs 5σ, and σ is the larger of
the annulus's spread and the noise of the detector pixels that visit was cut from. The
annulus alone sits on the resampled grid, which bilinear interpolation smooths to about 0.64
of the detector's noise: against that, "5σ" let roughly one blank position in eight through
as a source over ten visits.

What comes back is a classification, not a fabricated trend:

| verdict | when |
| --- | --- |
| *nothing above the noise* | no 5σ peak in any visit |
| *there on \<date\> and in none of the others* | exactly one detection |
| *in N of M visits — \<dates\>* | two or three detections, not in every visit; the dates are listed, because two points always fit a line perfectly and quoting a scatter would be a number with no information in it |
| *in N of M visits, steady to X″* | four or more, not in every visit, no measurable motion |
| *steady to X″* | in every visit, no measurable motion |
| *moving X″/h* | three or more, and the straight-line motion across the baseline beats both a 6.15″ detector pixel and twice the fit's own residual. Hunter X is stricter and ranks a mover only from four detections |

Brightness ranges are only reported when every detection came from the same band —
position compares across bands, brightness does not.

---

## Taking a measurement out

A marked point can be saved as a table: "Save measurements (CSV)" in the mark's panel
writes one row a visit, with the date, the exposure id, the band, the position found, the
flux in mJy in a 3×3-pixel aperture (no aperture correction), the AB magnitude and the
peak signal-to-noise. The field itself is in the page's address, so a link reproduces the
view, and the plate can be saved as a PNG or the blink recorded as WebM.

## Does it actually work? The Atala field

The opening preset is not decorative. It was found by searching real SPHEREx frames along
the ecliptic for catalogued objects bright enough to detect (`tools/find-mover.mjs`), then
checked photometrically (`tools/verify-mover.mjs`).

Field: **RA 13.4194, Dec +3.8459**, band D2 (1.10–1.65 µm). Fifteen D2 visits over
369 days in SPHEREx DR1 and QR3, re-measured on 13 Nov 2026 when DR1 replaced the
Quick Release 2 frames. Signal-to-noise at the exact field centre, visit by visit:

```
2025-07-06T11:41:24     1.6   ██
2025-07-07T20:18:06     3.1   ███
2025-07-09T03:23:15     0.8   █
2025-07-19T11:04:07     2.4   ██
2025-12-24T11:12:16     3.5   ████
2025-12-25T16:33:36   533.1   ████████████████████████████████████████
2026-01-01T01:44:29     2.9   ███
2026-01-01T08:21:29     1.4   █
2026-01-03T05:59:11     3.8   ████
2026-01-04T14:32:35     1.2   █
2026-07-03T09:52:56     3.0   ███
2026-07-03T19:44:45     2.3   ██
2026-07-04T18:27:55     2.1   ██
2026-07-05T05:58:03     2.1   ██
2026-07-10T06:30:49     1.4   █
```

One spike. Fourteen visits of pure background.

**25 Dec 2025 — SNR 533.** SkyBoT places **(152) Atala**, a main-belt asteroid at V = 13.81,
2.3″ from the field centre at that exposure's timestamp. Muninn rings it and
names it, live, from the ephemeris.

**6 Jul 2025 — the spike that was not there.** Before Muninn read the `FLAGS` plane,
this visit showed SNR 192 at the same spot (206 in QR2), and nothing in the catalogue
explained it. It was one detector pixel at eleven times its neighbours — and the pipeline
had already said what it was: `FLAGS = 0x45` in DR1, `TRANSIENT` + `SUR_ERROR` + `NONFUNC`
(QR2 had `0x80005`, with `OUTLIER` for the last), a cosmic-ray jump caught during the
up-the-ramp readout. DR1 stores `FLAGS` as a Rice-compressed tile image; Muninn decodes
it in the browser (`public/js/rice.js`), and the decoded counts match the `N_TRANSIENT`,
`N_PERSIST` and other totals in the file's own header.
Atala's own pixels on 25 Dec carry only `OUTLIER`, and spread over the point-spread
function the way a real source does. With the flags read, 6 July is background like the
rest.

That is the kind of thing this tool exists to settle. Open (152) Atala, click the centre
of the image and read the verdict: one visit, named by SkyBoT as the asteroid.

---

## Limitations, stated plainly

- **Released data only.** The app queries `spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3`
  and `spherex_qr3_deep`: DR1 holds the reprocessed frames from April 2025 to mid-May 2026, QR3 those from
  mid-May to early October 2026. Coverage
  is not uniform over the whole sky; some positions return nothing.
- **The archive caps large queries.** A cone at the ecliptic poles matches over 25 000
  frames and takes four minutes unserved. We ask for `MAXREC=500` per collection and say so
  in the interface when the list came back truncated.
- **Ten visits at a time**, sampled to span the full time baseline rather than taking the
  first ten. Fields with more visits than that are listed but not all loaded.
- **Brightness across bands is not comparable.** SPHEREx is a spectral survey with a linear
  variable filter; the wavelength at a given pixel depends on where it falls on the
  detector. The band filter and the per-band wavelength labels exist for this reason.
- **The spectrum of a mark is six points from six exposures.** Each sits at the wavelength
  read from that file's `WCS-WAVE` table, in a 3×3-pixel aperture with no aperture
  correction, so part of a source's light is left out of every point. The detectors do not look
  at the same sky at once: the exposures can be days apart, the block says how far, and a
  mover absent from a band's nearest exposure is drawn as a 5σ upper limit.
- **Known-object marks are geocentric.** SPHEREx is in low-Earth orbit, about 7 000 km from
  the Earth's centre, which shifts a main-belt asteroid by 3–7″ — up to about one pixel,
  inside the two-pixel radius a SkyBoT match allows, but it would matter for anything closer.
- **The photometry is simple.** Background annulus, peak, flux-weighted centre, then a sum
  over a 3×3-pixel aperture on the resampled grid, in AB magnitudes. It is honest about failing
  (it reports "nothing above the noise") but it is not PSF photometry, it is not corrected for
  the light outside the aperture, and it does not match wavelengths between visits.
- **The distance bound assumes a circular orbit in the ecliptic.** It is a ceiling from a rate,
  not an orbit fit.
- **The relay is not hardened for abuse.** It caps twelve lookups in flight, but has no per-client
  limit and never prunes its disk cache.
- **No video yet.** The submission's 30-second recording is not made; the eight slides are.
- **Cosmic rays look like transients.** They are single-frame, sharp, and common. The ones
  the pipeline caught are masked through `FLAGS`; the ones it missed are not. Anything
  seen exactly once still deserves that explanation first.

---

## Data and services

| | |
| --- | --- |
| Images | NASA/JPL-Caltech · SPHEREx · IPAC/IRSA Data Release 1 and Quick Release 3, via the AWS Open Data mirror `nasa-irsa-spherex` |
| Frame index | IRSA Simple Image Access v2 (`irsa.ipac.caltech.edu/SIA`) |
| Known solar-system objects | NASA/JPL Small-Body Identification API (`ssd-api.jpl.nasa.gov/sb_ident.api`), through the relay; SkyBoT, IMCCE / Observatoire de Paris, from the browser. Both asked, merged by number or name |
| What a marked source is, and the Gaia / WISE overlay | Gaia DR3, AllWISE, CatWISE2020 and 2MASS through IRSA TAP (`irsa.ipac.caltech.edu/TAP`), via the relay. Gaia DR3, AllWISE and 2MASS are also asked of VizieR TAP, CDS Strasbourg, and the first answer is used, so either archive being down leaves the other |
| Variable stars | AAVSO VSX through VizieR TAP, CDS Strasbourg; no NASA equivalent |
| Object names | SIMBAD / Sesame, CDS Strasbourg; no NASA equivalent |

Each catalogue is asked on its own: one that does not answer leaves the rest of a
marked source's card standing, and the card names the one that did not. The overlay's
legend says which archive answered, NASA IRSA or CDS VizieR.

Muninn is not affiliated with NASA, and it adds nothing to the data it shows.

---

## Licence

The code is under the MIT licence, see `LICENSE`. The data it displays belongs to its
sources, listed under "Data and services" above.

## Layout

```
server.js                 static host (compressed, with the security headers) + the IRSA and JPL relays + disk cache
public/
  index.html
  css/tokens.css          the design system: colour, type, space, motion
  css/app.css
  js/fits.js              FITS reader that works from partial byte ranges
  js/wcs.js               TAN + SIP, both directions, plus the shared tangent grid
  js/stamp.js             range-fetch one visit and its FLAGS, mask, resample onto that grid
  js/render.js            percentile clip, stretch curves, colour ramps read from CSS
  js/sky.js               the canvas: compositing, overlays, marks, photometry
  js/stack.js             seasons, and adding one season's visits up
  js/depth.js             sky noise, 5σ limits, what a coadd would reach
  js/hunt.js              rate to distance, and the guards on it
  js/sectors.js           the 5 × 4 sector scores
  js/release.js           which SPHEREx release (IRSA collections) is read
  js/net.js               a deadline for every request the page makes
  js/catalog.js           SIA, the catalogues (IRSA and VizieR), SkyBoT and JPL, SIMBAD, coordinate parsing
  js/overlay.js           the catalogue templates for both archives, overlay arithmetic, row parsers
  js/sbident.js           the JPL small-body question and the reading of its answer
  js/csv.js               TAP CSV answers as rows of text
  js/votable.js           just enough IVOA VOTable for both services
  js/i18n.js              English and Russian
  js/app.js               state, wiring, the loading choreography
  js/talk.js              the eight slides at talk.html; slide 1 reads frames live
  data/targets.json       the ten opening fields, with counts from the archive
  data/fields/*.json      their frame indexes, pre-resolved so they open in ~80 ms
tools/                    the scripts that verified all of the above
tests/                    npm test — offline, no network
design/                   a design study, not deployed
```

No build step. No dependencies. No framework.

### Static hosting

`public/` is a complete static site. The pre-resolved field indexes ship inside it,
and the pixels come straight from the CORS-enabled AWS mirror, so the ten ready
fields work on any static host — GitHub Pages, Netlify, Cloudflare Pages — with no
server at all. Searching an arbitrary position is the one thing that needs
`server.js`, because IRSA's index sends no CORS headers; without the relay the page
says so plainly instead of failing silently. The catalogues and known asteroids work
there too, from VizieR and SkyBoT; the NASA routes to them (IRSA TAP, JPL) need the relay.

One place it will *not* work is a sandbox with a strict content-security policy that
blocks cross-origin `fetch` — the whole design depends on reading byte ranges from
the NASA mirror.

---

## По-русски, коротко

SPHEREx снимает всё небо целиком примерно дважды в год, поэтому у большинства точек есть
снимки на несколько разных дат. Звёзды стоят на месте, тела Солнечной системы — нет.
Muninn складывает заходы друг на друга и показывает разницу.

Кадры SPHEREx — файлы по 70 МБ. Браузер читает их прямо из публичного зеркала AWS по
диапазонам байтов: сначала заголовок, потом только те строки детектора, на которые
попадает поле, и флаги качества пайплайна для тех же строк. Заход обходится в
несколько мегабайт. Между заходами аппарат
разворачивается, поэтому перед сравнением каждый кадр пересчитывается на общую
касательную плоскость с севером вверх.

Стартовое поле выбрано не наугад: 25 декабря 2025 года в его центре стоит астероид
**(152) Atala** (V = 13.8) — SNR 533 против фона 1–4 во всех остальных заходах. Раньше
6 июля в той же точке была «вспышка» SNR 192 без объяснения в каталогах. Это один пиксель,
который пайплайн SPHEREx сам пометил как попадание космической частицы (`FLAGS = 0x45` в DR1,
`TRANSIENT`). С DR1 флаги хранятся в сжатии Rice, Muninn распаковывает их в браузере. Теперь Muninn читает эти флаги и маскирует такие пиксели до любых измерений.

Запуск: `node server.js`, затем <http://127.0.0.1:5173>. Зависимостей нет.

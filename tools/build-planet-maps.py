"""Build the 1024x512 planet surface maps for the fly view.

Downloads each global mosaic from its NASA / USGS source into a raw folder
outside the repo, resamples it to 1024x512 simple cylindrical, writes
public/data/fly/tex/<key>.jpg and the provenance file maps.json.

Usage: python -I tools/build-planet-maps.py <raw-download-dir>
"""

import json
import sys
import urllib.request
from pathlib import Path

from PIL import Image

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "data" / "fly" / "tex"
SIZE = (1024, 512)
MAX_BYTES = 250 * 1024
USGS_CKAN = "https://astrogeology.usgs.gov/ckan/dataset/"

# Every map below is simple cylindrical with 0 deg longitude at the centre,
# the left edge at 180 deg and east longitude increasing to the right.
MAPS = {
    "mercury": {
        "url": USGS_CKAN + "fc37692f-e806-4632-b300-0250bb61c3de/resource/b1ef80b6-a44a-4c24-8786-e5e901842657/download/mercury_messenger_mdis_basemap_md3color_mosaic_global_1024.jpg",
        "page": "https://astrogeology.usgs.gov/search/map/mercury_messenger_mdis_basemap_md3_color_global_mosaic_665m",
        "credit": "NASA / Johns Hopkins APL / Carnegie Institution of Washington; MESSENGER MDIS MD3 colour mosaic via USGS Astrogeology",
        "licence": "Public domain (NASA mission data, distributed by USGS)",
        "shows": "false colour: MDIS 1000 / 750 / 430 nm filters in R / G / B, not what the eye would see",
        "notes": "A few rows at each pole have no data and are black.",
    },
    "venus": {
        "url": USGS_CKAN + "f992cb3c-4f37-4e1a-a59d-4f29d8307d7d/resource/d97f7bf8-73da-46fe-9edb-95c9ad233b10/download/venus_magellan_c3-mdir_clrtopo_global_mosaic_1024.jpg",
        "page": "https://astrogeology.usgs.gov/search/map/venus_magellan_global_c3_mdir_colorized_topographic_mosaic_6600m",
        "credit": "NASA / JPL; Magellan C3-MDIR radar mosaic coloured by altimetry, via USGS Astrogeology",
        "licence": "Public domain (NASA mission data, distributed by USGS)",
        "shows": "radar: Magellan SAR backscatter, colour codes elevation (blue low, red high); the surface under the clouds, not the visible planet",
        "notes": "",
    },
    "earth": {
        "url": "https://svs.gsfc.nasa.gov/vis/a010000/a012500/a012564/frames/5400x2700_2x1_60p/world.topo.2004-07.png",
        "page": "https://svs.gsfc.nasa.gov/12564",
        "credit": "NASA Earth Observatory / NASA Scientific Visualization Studio; Blue Marble: Next Generation (Terra MODIS), July 2004",
        "licence": "Public domain (NASA); credit requested",
        "shows": "true colour, cloud-free monthly composite with shaded topography",
        "notes": "",
    },
    "moon": {
        "url": "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_2k.tif",
        "page": "https://svs.gsfc.nasa.gov/4720",
        "credit": "NASA's Scientific Visualization Studio; CGI Moon Kit from LRO LROC WAC data",
        "licence": "Public domain (NASA)",
        "shows": "near true colour, LROC WAC mosaic with the poles filled",
        "notes": "",
    },
    "mars": {
        "url": USGS_CKAN + "7131d503-cdc9-45a5-8f83-5126c0fd397e/resource/6afad901-1caa-48a7-8b62-3911da0004c2/download/mars_viking_mdim21_clrmosaic_global_1024.jpg",
        "page": "https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m",
        "credit": "NASA / USGS / NASA Ames; Viking Orbiter colour mosaic over MDIM 2.1",
        "licence": "Public domain (USGS)",
        "shows": "approximate true colour, Viking colour blended over the MDIM 2.1 mosaic",
        "notes": "",
    },
    "jupiter": {
        "url": "https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia07/pia07782/PIA07782.jpg",
        "page": "https://science.nasa.gov/photojournal/cassinis-best-maps-of-jupiter-cylindrical-map/",
        "credit": "NASA / JPL / Space Science Institute; Cassini ISS, PIA07782, December 2000",
        "licence": "Public domain (NASA / JPL)",
        "shows": "near true colour, built from 750 nm and 451 nm frames",
        "notes": "Grid version labels System III west longitude 180 (left) .. 0 (centre) .. 180 (right), i.e. east longitude increases to the right. The source is 3601x1801 with a repeated edge column and row, cropped to 3600x1800 before resampling.",
        "crop": (0, 0, 3600, 1800),
    },
}

SKIPPED = {
    "saturn": "No global cylindrical colour map of Saturn's cloud tops is published on NASA / JPL / USGS domains; Cassini maps there cover only the moons and rings.",
    "uranus": "Voyager 2 saw an almost featureless disc; no global map exists from NASA sources.",
    "neptune": "Voyager 2 imaged only part of the planet during one flyby; no global map exists from NASA sources.",
}


def fetch(url, raw_dir):
    target = raw_dir / url.rsplit("/", 1)[-1]
    if not target.exists():
        request = urllib.request.Request(url, headers={"User-Agent": "planet-map-builder/1.0"})
        with urllib.request.urlopen(request, timeout=300) as response:
            target.write_bytes(response.read())
    return target


def save_jpeg(image, path):
    for quality in (80, 75, 70, 65):
        image.save(path, "JPEG", quality=quality, progressive=True, optimize=True)
        if path.stat().st_size <= MAX_BYTES:
            return quality
    return quality


def build(key, spec, raw_dir):
    with Image.open(fetch(spec["url"], raw_dir)) as source:
        image = source.convert("RGB")
    if "crop" in spec:
        image = image.crop(spec["crop"])
    image = image.resize(SIZE, Image.LANCZOS)
    path = OUT_DIR / f"{key}.jpg"
    quality = save_jpeg(image, path)
    return {
        "file": path.name,
        "width": SIZE[0],
        "height": SIZE[1],
        "jpegQuality": quality,
        "sourceUrl": spec["url"],
        "sourcePage": spec["page"],
        "credit": spec["credit"],
        "licence": spec["licence"],
        "shows": spec["shows"],
        "projection": "simple cylindrical (equirectangular), latitude +90 at the top edge, -90 at the bottom",
        "leftEdgeLongitudeDeg": -180,
        "centreLongitudeDeg": 0,
        "longitudeIncreasesEastwardToRight": True,
        "notes": spec["notes"],
    }


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python -I tools/build-planet-maps.py <raw-download-dir>")
    raw_dir = Path(sys.argv[1])
    raw_dir.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    maps = {key: build(key, spec, raw_dir) for key, spec in MAPS.items()}
    manifest = {"maps": maps, "skipped": SKIPPED}
    (OUT_DIR / "maps.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for key, entry in maps.items():
        size_kb = (OUT_DIR / entry["file"]).stat().st_size / 1024
        print(f"{key:8s} {size_kb:6.1f} KB  q{entry['jpegQuality']}")


if __name__ == "__main__":
    main()

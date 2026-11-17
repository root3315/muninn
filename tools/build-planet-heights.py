"""Build the 1024x512 relief (height) maps for the fly view.

Downloads each measured global elevation model from its NASA / USGS / NOAA
source into a raw folder outside the repo, area-averages it to 1024x512
simple cylindrical (latitude +90 at the top, longitude -180 at the left edge,
east to the right, same layout as the colour maps), maps the height linearly
to 16-bit grey (0 = lowest point of the map, 65535 = highest), writes
public/data/fly/tex/<key>-height.png and adds the `heights` block to maps.json.
Each raw file is deleted once it has been converted.

Usage: python -I tools/build-planet-heights.py <raw-download-dir> [key ...]
"""

import json
import struct
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "data" / "fly" / "tex"
WIDTH, HEIGHT = 1024, 512
BAND_ROWS = 240
MAX_BYTES = 600 * 1024
MIN_BITS = 10

SVS_MOON = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"
MOLA_MEGDR = "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg004/"
USGS_MOSAIC = "https://planetarymaps.usgs.gov/mosaic/"
ETOPO1 = "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO1/data/ice_surface/cell_registered/binary/"

# reader: how to open the raw file. scale: metres per stored unit.
# left_lon: east longitude of the source's left edge (0 or -180).
HEIGHTS = {
    "mercury": {
        "url": USGS_MOSAIC + "Mercury_Messenger_USGS_DEM_Global_665m_v2.tif",
        "page": "https://astrogeology.usgs.gov/search/map/mercury_messenger_global_dem_665m",
        "credit": "NASA / Johns Hopkins APL / Carnegie Institution of Washington; MESSENGER MDIS stereo-control DEM v2 by USGS Astrogeology (Becker et al. 2016)",
        "licence": "Public domain (NASA mission data, distributed by USGS)",
        "datum": "sphere of radius 2439.4 km",
        "reader": "geotiff", "scale": 0.5, "left_lon": 0.0,
        "notes": "Source 23040x11520 (64 px/deg, 665 m/px), int16 x 0.5 m; the file spans 0..360 E (centre 180), rolled so -180 is at the left. Interpolated from a stereo control-network point cloud and smoothed, so craters are softened. No gaps after averaging. Lowest cell is Rachmaninoff basin, highest is south of the equator near 61 E.",
    },
    "venus": {
        "url": USGS_MOSAIC + "Venus_Magellan_Topography_Global_4641m_v02.tif",
        "page": "https://astrogeology.usgs.gov/search/map/venus_magellan_global_topography_4641m",
        "credit": "NASA / JPL / MIT; Magellan radar altimetry (GTDR), mosaic by USGS Astrogeology",
        "licence": "Public domain (NASA mission data, distributed by USGS)",
        "datum": "sphere of radius 6051.0 km",
        "reader": "geotiff", "scale": 1.0, "left_lon": -180.0,
        "notes": "Source 8192x4096 (4641 m/px) resampled from the Magellan GTDR altimetry, whose true footprint is 10-30 km, so fine detail is interpolated. 8.3 % of source cells have no altimetry: the caps within about 2 deg of each pole and swaths at 60-80 S and near 80 N. Output cells with no data at all (7.6 %) are filled with the mean of their neighbours, growing inward, so those areas are smooth guesses, not measurements.",
    },
    "earth": {
        "url": ETOPO1 + "etopo1_ice_c_i2.zip",
        "page": "https://www.ncei.noaa.gov/products/etopo-global-relief-model",
        "credit": "NOAA National Centers for Environmental Information; ETOPO1 Global Relief Model, ice surface (Amante & Eakins 2009)",
        "licence": "Public domain (US Government work, NOAA NCEI)",
        "datum": "sea level (EGM96 geoid / mean sea level); land and sea floor together",
        "reader": "etopo1", "scale": 1.0, "left_lon": -180.0,
        "notes": "Source 21600x10800 (1 arc-minute) int16 metres, cell registered; land topography and ocean bathymetry in one grid, top of the Antarctic and Greenland ice sheets. No gaps. Near the output resolution already, so craters stay sharp; precision was cut to 10 bits (about 18 m steps) to keep the file near 600 KB. Area averaging over about 39 km cells flattens the tallest peaks and deepest trenches, so the range (Tibet to the Mariana Trench) is smaller than Everest to Challenger Deep.",
    },
    "moon": {
        "url": SVS_MOON + "ldem_4.tif",
        "page": "https://svs.gsfc.nasa.gov/4720",
        "credit": "NASA's Scientific Visualization Studio; CGI Moon Kit displacement map from LRO LOLA data",
        "licence": "Public domain (NASA)",
        "datum": "sphere of radius 1737.4 km",
        "reader": "float_tiff", "scale": 1000.0, "left_lon": -180.0,
        "notes": "Source 1440x720 (4 px/deg) float32 kilometres, LRO LOLA global DEM resampled by NASA SVS. No gaps. Near the output resolution already, so craters stay sharp; precision was cut to 10 bits (about 18 m steps) to keep the file near 600 KB.",
    },
    "mars": {
        "url": MOLA_MEGDR + "megt90n000cb.img",
        "page": "https://pds-geosciences.wustl.edu/missions/mgs/megdr.html",
        "credit": "NASA / GSFC / MIT; MGS MOLA Mission Experiment Gridded Data Record MEGT90N000CB (Smith et al. 2003), PDS Geosciences Node",
        "licence": "Public domain (NASA PDS)",
        "datum": "areoid (MOLA equipotential surface), mean equatorial radius 3396.0 km",
        "reader": "pds_msb_int16", "scale": 1.0, "left_lon": 0.0,
        "shape": (720, 1440),
        "notes": "Source 1440x720 (4 px/deg) int16 metres, median MOLA shot height per 0.25 deg cell; cells with no shot were interpolated by the MOLA team. Longitude 0..360 in the file, rolled so -180 is at the left.",
    },
}

SKIPPED = {
    "jupiter": "Gas giant: no solid surface, so there is no elevation model.",
    "saturn": "Gas giant: no solid surface, so there is no elevation model.",
    "uranus": "Ice giant: no solid surface, so there is no elevation model.",
    "neptune": "Ice giant: no solid surface, so there is no elevation model.",
}


def download(url, raw_dir):
    path = raw_dir / url.rsplit("/", 1)[1]
    if not path.exists():
        print(f"downloading {url}")
        urllib.request.urlretrieve(url, path)
    return path


def column_sums(band, n_out):
    """Area-weighted sums of a band's columns into n_out equal output columns.

    Integrates the piecewise-constant rows exactly: the running sum is
    interpolated linearly at the fractional output-cell edges.
    """
    n_src = band.shape[1]
    running = np.zeros((band.shape[0], n_src + 1))
    np.cumsum(band, axis=1, out=running[:, 1:])
    edges = np.linspace(0.0, n_src, n_out + 1)
    index = np.minimum(edges.astype(int), n_src - 1)
    frac = edges - index
    at_edges = running[:, index] + frac * (running[:, index + 1] - running[:, index])
    return np.diff(at_edges, axis=1)


def row_weights(n_src, n_out):
    """Matrix (n_out x n_src) of the fraction of each source row inside each output row."""
    edges = np.linspace(0.0, n_src, n_out + 1)
    rows = np.arange(n_src)
    return np.clip(np.minimum(edges[1:, None], rows + 1) - np.maximum(edges[:-1, None], rows), 0.0, None)


class AreaAverager:
    """Accumulates row bands of a source grid into the 1024x512 area average, ignoring NaN."""

    def __init__(self, src_height, src_width):
        self.wy = row_weights(src_height, HEIGHT).astype(np.float32)
        self.total = np.zeros((HEIGHT, WIDTH))
        self.weight = np.zeros((HEIGHT, WIDTH))

    def add(self, row0, band):
        valid = np.isfinite(band)
        values = np.where(valid, band, 0.0)
        wy = self.wy[:, row0:row0 + band.shape[0]].astype(np.float64)
        self.total += wy @ column_sums(values, WIDTH)
        self.weight += wy @ column_sums(valid.astype(np.float64), WIDTH)

    def result(self):
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where(self.weight > 0, self.total / self.weight, np.nan)


def geotiff_strips(path):
    """Memory-map an uncompressed single-band int16 GeoTIFF; returns (array, nodata)."""
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(path) as im:
        tags = im.tag_v2
        width, height = tags[256], tags[257]
        if tags[259] != 1 or tags[258] != (16,) or tags.get(339, (2,)) != (2,):
            raise ValueError(f"{path.name}: expected uncompressed signed 16-bit")
        offsets, counts = tags[273], tags[279]
        nodata = float(tags[42113]) if 42113 in tags else None
    contiguous = all(offsets[i] + counts[i] == offsets[i + 1] for i in range(len(offsets) - 1))
    if not contiguous or sum(counts) != width * height * 2:
        raise ValueError(f"{path.name}: strips are not one contiguous block")
    return np.memmap(path, dtype="<i2", mode="r", offset=offsets[0], shape=(height, width)), nodata


def average_int16(grid, nodata, scale):
    averager = AreaAverager(*grid.shape)
    for row0 in range(0, grid.shape[0], BAND_ROWS):
        band = np.asarray(grid[row0:row0 + BAND_ROWS], dtype=np.float64)
        if nodata is not None:
            band[band == nodata] = np.nan
        averager.add(row0, band * scale)
    return averager.result()


def read_geotiff(path, spec):
    grid, nodata = geotiff_strips(path)
    try:
        return average_int16(grid, nodata, spec["scale"])
    finally:
        grid._mmap.close()


def read_pds_msb_int16(path, spec):
    grid = np.fromfile(path, dtype=">i2").reshape(spec["shape"])
    return average_int16(grid, None, spec["scale"])


def read_float_tiff(path, spec):
    with Image.open(path) as im:
        grid = np.asarray(im, dtype=np.float64)
    return average_int16(grid, None, spec["scale"])


def read_etopo1(path, spec):
    """Stream the 21600x10800 little-endian int16 grid out of the zip, band by band."""
    with zipfile.ZipFile(path) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".bin"))
        header = next(n for n in archive.namelist() if n.endswith(".hdr"))
        fields = dict(line.split(None, 1) for line in archive.read(header).decode().splitlines() if line.strip())
        cols, rows = int(fields["NCOLS"]), int(fields["NROWS"])
        if fields["BYTEORDER"].strip() != "LSBFIRST" or float(fields["XLLCORNER"]) != -180.0:
            raise ValueError("unexpected ETOPO1 header")
        nodata = float(fields["NODATA_VALUE"]) if "NODATA_VALUE" in fields else None
        averager = AreaAverager(rows, cols)
        with archive.open(name) as stream:
            for row0 in range(0, rows, BAND_ROWS):
                count = min(BAND_ROWS, rows - row0)
                raw = stream.read(count * cols * 2)
                band = np.frombuffer(raw, dtype="<i2").reshape(count, cols).astype(np.float64)
                if nodata is not None:
                    band[band == nodata] = np.nan
                averager.add(row0, band * spec["scale"])
    return averager.result()


READERS = {
    "geotiff": read_geotiff,
    "pds_msb_int16": read_pds_msb_int16,
    "float_tiff": read_float_tiff,
    "etopo1": read_etopo1,
}


def fill_gaps(heights):
    """Fill cells with no data from the mean of their valid neighbours, growing inward."""
    filled = heights.copy()
    missing = np.isnan(filled)
    count = int(missing.sum())
    while missing.any():
        padded = np.pad(filled, 1, mode="edge")
        padded[:, 0], padded[:, -1] = padded[:, -2], padded[:, 1]
        stack = np.stack([padded[1 + dy:1 + dy + HEIGHT, 1 + dx:1 + dx + WIDTH]
                          for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx])
        known = np.isfinite(stack)
        counts = known.sum(axis=0)
        sums = np.where(known, stack, 0.0).sum(axis=0)
        neighbour_mean = np.where(counts > 0, sums / np.maximum(counts, 1), np.nan)
        newly = missing & np.isfinite(neighbour_mean)
        if not newly.any():
            raise ValueError("cannot fill gaps")
        filled[newly] = neighbour_mean[newly]
        missing = np.isnan(filled)
    return filled, count


def to_png(heights, path):
    """Write the 16-bit PNG. Precision drops below 16 bits only if needed to stay under MAX_BYTES."""
    low, high = float(heights.min()), float(heights.max())
    unit = (heights - low) / (high - low)
    for bits in range(16, MIN_BITS - 1, -1):
        levels = 2 ** bits - 1
        grey = np.round(np.round(unit * levels) * (65535 / levels)).astype(np.uint16)
        Image.fromarray(grey).save(path, optimize=True)
        if path.stat().st_size <= MAX_BYTES:
            break
    return low, high, bits


def build(key, spec, raw_dir):
    raw = download(spec["url"], raw_dir)
    heights = READERS[spec["reader"]](raw, spec)
    if spec["left_lon"] == 0.0:
        heights = np.roll(heights, WIDTH // 2, axis=1)
    heights, gaps = fill_gaps(heights)
    out = OUT_DIR / f"{key}-height.png"
    low, high, bits = to_png(heights, out)
    raw.unlink()
    print(f"{key}: {low:.0f} .. {high:.0f} m, {gaps} cells filled, {bits} bits, {out.stat().st_size // 1024} KB")
    return {
        "file": out.name,
        "width": WIDTH,
        "height": HEIGHT,
        "encoding": "16-bit grey PNG; metres = minMetres + value / 65535 * (maxMetres - minMetres); values sit on 2^precisionBits evenly spaced levels",
        "precisionBits": bits,
        "stepMetres": round((high - low) / (2 ** bits - 1), 2),
        "minMetres": round(low, 1),
        "maxMetres": round(high, 1),
        "datum": spec["datum"],
        "sourceUrl": spec["url"],
        "sourcePage": spec["page"],
        "credit": spec["credit"],
        "licence": spec["licence"],
        "projection": "simple cylindrical (equirectangular), latitude +90 at the top edge, -90 at the bottom",
        "leftEdgeLongitudeDeg": -180,
        "centreLongitudeDeg": 0,
        "longitudeIncreasesEastwardToRight": True,
        "resampling": "area average of every source cell; minMetres / maxMetres are the extremes of this 1024x512 average, not of the source",
        "filledCells": gaps,
        "notes": spec["notes"],
    }


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    raw_dir = Path(sys.argv[1])
    raw_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT_DIR / "maps.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    heights = dict(manifest.get("heights", {}))
    for key in (sys.argv[2:] or HEIGHTS):
        heights[key] = build(key, HEIGHTS[key], raw_dir)
    manifest["heights"] = {key: heights[key] for key in HEIGHTS if key in heights}
    manifest["heights"]["skipped"] = SKIPPED
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

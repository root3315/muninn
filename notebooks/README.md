# Notebooks

`verify-with-astropy.ipynb` checks Muninn's key numbers with standard Python tools, following the SPHEREx Tutorial Notebooks and the CSA's NEOSSat Data Tutorial: the DR1 frames of the Atala field found through IRSA SIA, the FLAGS bit counts (astropy's Rice decoder against the header totals), the flagged 6 Jul pixel and Atala on 25 Dec through the frame's SIP WCS, the asteroid's name from SkyBoT, and the NEOSSat frames of Barnard's Star at CADC.

```bash
pip install astropy astroquery pyvo s3fs matplotlib
jupyter lab
```

Frames are read from IRSA's S3 mirror, or downloaded once (~65 MB each) to the system temp directory if S3 cannot be reached; no data is written to the repository.

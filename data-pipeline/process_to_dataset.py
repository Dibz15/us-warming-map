"""
Parses raw NOAA county files (data-pipeline/raw/) into the compact JSON
consumed by the site: public/data/counties.json, matching the CountyDataset
shape in src/types.ts.

Steps (planned):
  1. Parse fixed-width climdiv files into a long-format DataFrame
     (fips, year, tmax, tmin).
  2. Drop counties/years with insufficient coverage.
  3. Fit an OLS trend to the annual mean((tmax+tmin)/2) series per county
     to get slopeFPerDecade (drives the choropleth color).
  4. Join FIPS codes to county/state names.
  5. Write public/data/counties.json.

Not implemented yet — scaffolding only.
"""


def main() -> None:
    raise NotImplementedError


if __name__ == "__main__":
    main()

"""
Parses raw NOAA county files (data-pipeline/raw/) into the compact JSON
consumed by the site: public/data/counties.json, matching the CountyDataset
shape in src/types.ts.

Steps:
  1. Parse fixed-width climdiv files into a long-format DataFrame
     (fips, year, tmax, tmin, tmean).
  2. Drop counties/years with insufficient coverage.
  3. Fit an OLS trend to the annual mean((tmax+tmin)/2) series per county
     to get slopeFPerDecade (drives the choropleth color).
  4. Join FIPS codes to county/state names in county_lookup.json.
  5. Write public/data/counties.meta.json and public/data/counties.series.json.

This implementation splits the output into two files:
- counties.meta.json: metadata and slopes keyed by FIPS
- counties.series.json: columnar time series data
"""

import os
import re
import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime
import json
from scipy import stats

# Column specifications based on actual NOAA climdiv fixed-width format
# Example line: 01001271895  53.70  48.70  67.60...
#              │││││││└─────┘││   │     │     └─ pos 20 = FEB (48.70)
#              ││││││  year   └───└─────└─────── pos 13 = JAN (53.70)
#              ││││││ (pos 7-10)                 each temp field is 5 chars
#              ││││││        two-space gap between fields
#              │││││└─────── ELEMENT=27 (tmax), 28 (tmin), or 02 (tmean)
#              └──────────── CNTYCODE = STATE+COUNTY FIPS (pos 0-4, 5 chars)
COLUMN_SPECS = {
    'CNTYCODE': (0, 5),   # State + county FIPS code (5 digits at pos 0-4)
    # Element code: 02=tmean, 27=tmax, 28=tmin (2 chars at pos 5-6)
    'ELEMENT': (5, 7),
    'YEAR': (7, 11),       # Year 4 digits (pos 7-10)
    # Monthly temperature values - each is a 5-char field with 2-space gap between fields
    'JAN': (13, 18),   # pos 13-17 + trailing space at 18
    'FEB': (20, 25),   # pos 20-24 + trailing space at 25
    'MAR': (27, 32),   # each field is 5 chars (+ 2 space gap) = 7 char stride
    'APR': (34, 39),
    'MAY': (41, 46),
    'JUNE': (48, 53),
    'JULY': (55, 60),
    'AUG': (62, 67),
    'SEPT': (69, 74),
    'OCT': (76, 81),
    'NOV': (83, 88),
    'DEC': (90, 95)
}

# Element codes (as integers to match the parsed dtype)
ELEMENT_CODES = {
    2: 'tmean',     # Average temperature
    27: 'tmax',     # Maximum temperature
    28: 'tmin'      # Minimum temperature
}


def read_raw_files():
    """Read all raw NOAA files and combine into a single DataFrame."""
    # Use absolute path to ensure we're looking in the right place
    raw_dir = Path(__file__).parent / "raw"
    if not raw_dir.exists():
        raise FileNotFoundError(
            f"Raw data directory not found: {raw_dir}")

    # Find all climdiv files in the raw directory
    files = list(raw_dir.glob("climdiv-*"))
    if not files:
        raise FileNotFoundError(f"No climdiv files found in {raw_dir}")

    all_dfs = []

    for file_path in files:
        print(f"Processing {file_path.name}")

        # Read fixed-width file with clean column specifications to avoid duplication issues
        colspecs = [COLUMN_SPECS[col] for col in COLUMN_SPECS.keys()]
        names = list(COLUMN_SPECS.keys())

        # Read without explicit string conversion - let pandas infer integer types for CNTYCODE and ELEMENT
        df = pd.read_fwf(
            file_path,
            colspecs=colspecs,
            names=names,
            # Only cast CNTYCODE to string (for leading zeros in FIPS)
            dtype={'CNTYCODE': str, 'YEAR': int}
        )

        # Replace -99.99 with NaN for temperature data
        temp_cols = ['JAN', 'FEB', 'MAR', 'APR', 'MAY',
                     'JUNE', 'JULY', 'AUG', 'SEPT', 'OCT', 'NOV', 'DEC']
        df[temp_cols] = df[temp_cols].replace(-99.99, np.nan)

        # Add file source for debugging
        df['source_file'] = file_path.name

        all_dfs.append(df)

    # Combine all files
    combined_df = pd.concat(all_dfs, ignore_index=True)
    return combined_df


def aggregate_to_annual_means(df):
    """Aggregate monthly data to annual means by element type."""
    temp_cols = ['JAN', 'FEB', 'MAR', 'APR', 'MAY',
                 'JUNE', 'JULY', 'AUG', 'SEPT', 'OCT', 'NOV', 'DEC']

    # Filter for each element type
    results = []

    for elem_code, elem_name in ELEMENT_CODES.items():
        elem_df = df[df['ELEMENT'] == elem_code].copy()

        if elem_code == 2:  # Average temperature - take mean of months
            elem_df['VALUE'] = elem_df[temp_cols].mean(axis=1)
        elif elem_code == 27:  # Maximum temperature - take max of months
            elem_df['VALUE'] = elem_df[temp_cols].max(axis=1)
        elif elem_code == 28:  # Minimum temperature - take min of months
            elem_df['VALUE'] = elem_df[temp_cols].min(axis=1)

        # Keep only necessary columns
        elem_df = elem_df[['CNTYCODE', 'YEAR', 'VALUE']]
        elem_df['ELEMENT'] = elem_name

        results.append(elem_df)

    # Combine all element types
    final_df = pd.concat(results, ignore_index=True)

    # Pivot to have one row per county-year with separate columns for each element
    pivot_df = final_df.pivot_table(
        index=['CNTYCODE', 'YEAR'],
        columns='ELEMENT',
        values='VALUE',
        aggfunc='first'  # In case of duplicates, take first (shouldn't happen)
    ).reset_index()

    return pivot_df


def compute_ols_slopes(df, value_col='VALUE'):
    """Compute OLS slope for a series of values.

    Args:
        df: DataFrame with 'YEAR' column and a value column (default 'VALUE').
        value_col: Name of the value column to use for regression.
    Returns:
        Slope coefficient, or NaN if regression fails.
    """
    if len(df) < 2:
        return float('nan')

    # Use scipy.stats.linregress for robust linear regression
    try:
        result = stats.linregress(df['YEAR'], df[value_col])
        # Return just the slope coefficient (first element of the named tuple)
        return float(result[0])
    except Exception:
        return float('nan')


def compute_slopes_per_county(df):
    """Compute slopes for each county and element type."""
    # Group by FIPS code and compute slope for each element
    slopes = {}

    for fips in df['CNTYCODE'].unique():
        county_data = df[df['CNTYCODE'] == fips]

        if fips not in slopes:
            slopes[fips] = {}

        # Compute slopes for each temperature type
        for elem_name in ['tmean', 'tmax', 'tmin']:
            if elem_name in county_data.columns and not county_data[elem_name].isna().all():
                elem_data = county_data[['YEAR', elem_name]].dropna()
                slope = compute_ols_slopes(elem_data, value_col=elem_name)
                slopes[fips][f'tslopeFPerDecade_{elem_name}'] = slope

    return slopes


# Global lookup table loaded from county_lookup.json
_county_lookup: dict[str, dict[str, str]] = {}


def _load_county_lookup() -> dict[str, dict[str, str]]:
    """Load the county lookup table from JSON file."""
    global _county_lookup
    if not _county_lookup:
        lookup_path = Path(__file__).parent / "county_lookup.json"
        try:
            with open(lookup_path, "r") as f:
                _county_lookup = json.load(f)
        except FileNotFoundError:
            print(f"Warning: County lookup file not found at {lookup_path}")
            print("Run create_county_lookup.py first to generate it.")
    return _county_lookup


def get_county_info_from_fips(fips: str) -> tuple[str, str]:
    """Get county name and state from FIPS code.

    Args:
        fips: 5-digit FIPS code (2-digit state + 3-digit county)

    Returns:
        Tuple of (county_name, state_abbrev). Falls back to generic naming
        if FIPS is not found in the lookup table.
    """
    lookup = _load_county_lookup()

    if fips in lookup:
        entry = lookup[fips]
        return (entry["name"], entry["state"])

    # Fallback for missing entries - extract state and county from FIPS
    if len(fips) >= 5:
        state_code = fips[:2]
        county_code = fips[2:]
        # Build a reasonable fallback name using standard state abbreviations
        from pathlib import Path as _Path

        STATE_MAP = {
            "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA",
            "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
            "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN",
            "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
            "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS",
            "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
            "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
            "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
            "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
            "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
            "56": "WY"
        }
        state = STATE_MAP.get(state_code, "XX")
        return (f"County_{county_code}", state)

    return (f"Unknown_{fips}", "XX")


def main():
    """Main function to process NOAA county climate data."""
    print("Starting data processing...")

    # Read all raw files
    df = read_raw_files()
    print(f"Read {len(df)} records")

    # Aggregate to annual means by element type
    annual_df = aggregate_to_annual_means(df)
    print(f"Aggregated to {len(annual_df)} county-year records")

    # Remove any rows with missing data for all three elements
    annual_df = annual_df.dropna(subset=['tmean', 'tmax', 'tmin'], how='all')

    # Compute slopes for each county and element type
    slopes = compute_slopes_per_county(annual_df)

    # Create metadata dictionary keyed by FIPS
    meta_data = {}
    series_data = {
        "startYear": 1895,
        "series": {}
    }

    # Get year range from data
    min_year = annual_df['YEAR'].min()
    max_year = annual_df['YEAR'].max()

    # Process each county to build metadata and series
    for fips in annual_df['CNTYCODE'].unique():
        county_data = annual_df[annual_df['CNTYCODE'] == fips]

        # Get county name and state (placeholder implementation)
        name, state = get_county_info_from_fips(fips)

        # Build metadata entry
        meta_entry = {
            "name": name,
            "state": state
        }

        # Add slope values if available
        if fips in slopes:
            for key, value in slopes[fips].items():
                meta_entry[key] = value

        meta_data[fips] = meta_entry

        # Build series data (columnar format)
        years = county_data['YEAR'].tolist()
        tmean_vals = county_data['tmean'].tolist()
        tmax_vals = county_data['tmax'].tolist()
        tmin_vals = county_data['tmin'].tolist()

        # Convert to integers representing tenths of degrees
        series_entry = {
            "tmean": [int(val * 10) if pd.notna(val) else None for val in tmean_vals],
            "tmax": [int(val * 10) if pd.notna(val) else None for val in tmax_vals],
            "tmin": [int(val * 10) if pd.notna(val) else None for val in tmin_vals]
        }

        series_data["series"][fips] = series_entry

    # Compute slope domains (percentiles)
    slope_domains = {
        "tmean": [-1.0, 1.0],
        "tmax": [-1.0, 1.0],
        "tmin": [-1.0, 1.0]
    }

    # Collect slopes by type for computing percentiles
    tmean_slopes = []
    tmax_slopes = []
    tmin_slopes = []

    for fips, meta in meta_data.items():
        for key, value in meta.items():
            if key.startswith('tslopeFPerDecade_'):
                if np.isfinite(value):  # More robust NaN check using numpy
                    if key == 'tslopeFPerDecade_tmean':
                        tmean_slopes.append(value)
                    elif key == 'tslopeFPerDecade_tmax':
                        tmax_slopes.append(value)
                    elif key == 'tslopeFPerDecade_tmin':
                        tmin_slopes.append(value)

    # Compute percentiles for each type
    if tmean_slopes:
        slope_domains["tmean"] = np.percentile(tmean_slopes, [1, 99]).tolist()

    if tmax_slopes:
        slope_domains["tmax"] = np.percentile(tmax_slopes, [1, 99]).tolist()

    if tmin_slopes:
        slope_domains["tmin"] = np.percentile(tmin_slopes, [1, 99]).tolist()

    # Add domains to metadata
    meta_data_with_domains = {
        "generatedAt": datetime.now().isoformat(),
        "sourceYearRange": [min_year, max_year],
        "slopeDomains": slope_domains,
        "counties": meta_data
    }

    # Write output files
    output_dir = Path("../public/data")
    output_dir.mkdir(exist_ok=True)

    # Convert numpy types to Python native types for JSON serialization
    def convert_numpy_types(obj):
        if isinstance(obj, np.integer):
            return int(obj)
        elif isinstance(obj, np.floating):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        elif isinstance(obj, dict):
            return {key: convert_numpy_types(value) for key, value in obj.items()}
        elif isinstance(obj, list):
            return [convert_numpy_types(item) for item in obj]
        return obj

    # Apply conversion to data before JSON serialization
    meta_data_with_domains_serializable = convert_numpy_types(
        meta_data_with_domains)
    series_data_serializable = convert_numpy_types(series_data)

    with open(output_dir / "counties.meta.json", "w") as f:
        json.dump(meta_data_with_domains_serializable, f, indent=2)

    with open(output_dir / "counties.series.json", "w") as f:
        json.dump(series_data_serializable, f, indent=2)

    print(f"Output written to {output_dir}")
    print("Processing complete!")


if __name__ == "__main__":
    main()

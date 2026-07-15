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

import argparse
import sys
from typing import Union
import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime
import json
from scipy import stats
from loguru import logger

# Column specifications based on actual NOAA climdiv fixed-width format
# Example line: 01001271895  53.70  48.70  67.60...

# Configure loguru logger with appropriate formatting for data pipeline output
# Use paths relative to this script's location
_SCRIPT_DIR = Path(__file__).resolve().parent
_LOG_DIR = _SCRIPT_DIR / "logs"
_LOG_DIR.mkdir(exist_ok=True)

logger.remove()  # Remove default handler
logger.add(
    _LOG_DIR / "pipeline.log",
    rotation="10 MB",
    retention="30 days",
    level="DEBUG",
    format="[{time:YYYY-MM-DD HH:mm:ss}] [{level: <7}] {name}:{function}:{line} - {message}"
)
logger.add(
    sys.stdout,
    level="INFO",
    format="[{time:HH:mm:ss}] <level>{level: <8}</level> {message}"
)

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
    'JAN': (12, 18),   # pos 12-17 + trailing space at 18
    'FEB': (19, 25),   # pos 19-24 + trailing space at 25
    'MAR': (26, 32),   # each field is 5 chars (+ 2 space gap) = 7 char stride
    'APR': (33, 39),
    'MAY': (40, 46),
    'JUNE': (47, 53),
    'JULY': (54, 60),
    'AUG': (61, 67),
    'SEPT': (68, 74),
    'OCT': (75, 81),
    'NOV': (82, 88),
    'DEC': (89, 95)
}

# Element codes (as integers to match the parsed dtype)
ELEMENT_CODES = {
    2: 'tmean',     # Average temperature
    27: 'tmax',     # Maximum temperature
    28: 'tmin'      # Minimum temperature
}

# State FIPS codes that were never assigned/used in the current standard.
# These should be excluded from county data output.
# - 02: Alaska (data gap after ~1980s, causes extreme slope outliers)
# - 03: Reserved for American Samoa but never used (dropped in 1987 revision)
# - 07: Reserved for Panama Canal Zone (defunct)
# - 14: Reserved for Guam (never used in this standard)
# - 15: Hawaii (data gap ending in ~1930s, causes extreme slope outliers)
# - 43: Reserved for Puerto Rico (never used in this standard)
# - 52: Reserved for Virgin Islands (never used in this standard)
INVALID_STATE_FIPS = {"02", "03", "07", "14", "15", "43", "52"}


def _is_valid_county(noaa_id: str) -> bool:
    """Check if county FIPS has a valid (used) state prefix.

    Args:
        noaa_id: 5-digit NOAA ID string (state + county, may have leading zeros).

    Returns:
        True if the state prefix is not in the set of reserved/unused codes.
    """
    # Ensure we're working with a padded 5-char string to preserve leading zeros
    padded_id = str(noaa_id).zfill(5)

    # NOAA has its own legacy code system that differs from FIPS
    # We need to convert from NOAA to FIPS before anything else
    noaa_state_code = int(padded_id[:2])
    fips_state = noaa_state_to_fips(noaa_state_code)
    return fips_state not in INVALID_STATE_FIPS


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
        logger.info(f"Processing {file_path.name}")

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
        df[temp_cols] = df[temp_cols].replace(-99.9, np.nan)

        # Add file source for debugging
        df['source_file'] = file_path.name

        all_dfs.append(df)

    # Combine all files
    combined_df = pd.concat(all_dfs, ignore_index=True)
    return combined_df


def aggregate_to_annual_means(df):
    """Aggregate monthly data to annual means by element type.

    Only computes annual aggregates for years with all 12 months of data.
    Partial-year values are set to NaN to prevent misleading statistics.

    Returns a long-form DataFrame with one row per county-year-element combo
    (tmean, tmax, tmin), and separate columns for CNTYCODE and YEAR.
    """
    temp_cols = ['JAN', 'FEB', 'MAR', 'APR', 'MAY',
                 'JUNE', 'JULY', 'AUG', 'SEPT', 'OCT', 'NOV', 'DEC']

    # Filter for each element type
    results = []

    for elem_code, elem_name in ELEMENT_CODES.items():
        elem_df = df[df['ELEMENT'] == elem_code].copy()

        # Check which rows have all 12 months of data (no NaN values)
        complete_mask = elem_df[temp_cols].notna().all(axis=1)

        if elem_code == 2:  # Average temperature - take mean of months
            elem_df['VALUE'] = elem_df[temp_cols].mean(axis=1)
        elif elem_code == 27:  # Maximum temperature - take max of months
            elem_df['VALUE'] = elem_df[temp_cols].max(axis=1)
        elif elem_code == 28:  # Minimum temperature - take min of months
            elem_df['VALUE'] = elem_df[temp_cols].min(axis=1)

        # Set VALUE to NaN for rows with incomplete data
        elem_df.loc[~complete_mask, 'VALUE'] = np.nan

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


def aggregate_to_short_form_dfs(df):
    """Aggregate monthly data to three short-form DataFrames (one per element type).

    Each DataFrame has:
      - Index: CNTYCODE (5-digit string)
      - Columns: YEAR (integers, e.g. 1895, 1896, ...)
      - Values: Temperature in Fahrenheit

    Only computes annual aggregates for years with all 12 months of data.
    Partial-year values are set to NaN to prevent misleading statistics.

    Steps:
      1. Compute annual values per element type (tmean, tmax, tmin).
      2. Drop county-year rows where ALL three elements are NaN.
      3. Pivot each element into its own short-form DataFrame.

    Returns:
        dict: {'tmean': df, 'tmax': df, 'tmin': df}
    """
    temp_cols = ['JAN', 'FEB', 'MAR', 'APR', 'MAY',
                 'JUNE', 'JULY', 'AUG', 'SEPT', 'OCT', 'NOV', 'DEC']

    # Compute annual values for each element type and collect in long-form
    rows: list[dict] = []
    for elem_code, elem_name in ELEMENT_CODES.items():
        elem_df = df[df['ELEMENT'] == elem_code].copy()

        # Check which rows have all 12 months of data (no NaN values)
        complete_mask = elem_df[temp_cols].notna().all(axis=1)

        if elem_code == 2:  # Average temperature - take mean of months
            elem_df['VALUE'] = elem_df[temp_cols].mean(axis=1)
        elif elem_code == 27:  # Maximum temperature - take max of months
            elem_df['VALUE'] = elem_df[temp_cols].max(axis=1)
        elif elem_code == 28:  # Minimum temperature - take min of months
            elem_df['VALUE'] = elem_df[temp_cols].min(axis=1)

        # Set VALUE to NaN for rows with incomplete data
        elem_df.loc[~complete_mask, 'VALUE'] = np.nan

        # Select only needed columns and rename VALUE to element name
        selected = elem_df[['CNTYCODE', 'YEAR', 'VALUE']].copy()
        selected[elem_name] = selected['VALUE']
        rows.append(selected[['CNTYCODE', 'YEAR', elem_name]])

    # Combine all element types into one long-form DataFrame
    long_df = pd.concat(rows, ignore_index=True)

    # Pivot to wide form (one row per county, columns=year, one sub-table per elem)
    # Start with tmean
    wide_tmean = long_df.pivot_table(
        index='CNTYCODE',
        columns='YEAR',
        values='tmean',
        aggfunc='first'
    )
    wide_tmax = long_df.pivot_table(
        index='CNTYCODE',
        columns='YEAR',
        values='tmax',
        aggfunc='first'
    )
    wide_tmin = long_df.pivot_table(
        index='CNTYCODE',
        columns='YEAR',
        values='tmin',
        aggfunc='first'
    )

    # Drop county-year rows where ALL three elements are NaN from each DF
    # (We drop entire rows where the county has no data for that element)
    wide_tmean = wide_tmean.dropna(how='all')
    wide_tmax = wide_tmax.dropna(how='all')
    wide_tmin = wide_tmin.dropna(how='all')

    # Ensure column types are integers
    for df_elem in [wide_tmean, wide_tmax, wide_tmin]:
        df_elem.columns = df_elem.columns.astype(int)

    return {
        'tmean': wide_tmean.sort_index(),
        'tmax': wide_tmax.sort_index(),
        'tmin': wide_tmin.sort_index()
    }


def compute_ols_slopes(df, value_col='VALUE'):
    """Compute OLS slope and standard error for a series of values.

    Args:
        df: DataFrame with 'YEAR' column and a value column (default 'VALUE').
        value_col: Name of the value column to use for regression.
    Returns:
        Tuple of (slope, slope_std_err), or (nan, nan) if regression fails.
    """
    if len(df) < 2:
        return float('nan'), float('nan')

    # Use scipy.stats.linregress for robust linear regression
    try:
        result = stats.linregress(df['YEAR'], df[value_col])
        # Return slope coefficient and its standard error
        return float(result.slope), float(result.stderr)
    except Exception:
        return float('nan'), float('nan')


def compute_slopes_per_county(short_form_dfs: dict[str, pd.DataFrame]) -> dict[str, dict[str, float]]:
    """Compute OLS slopes and standard errors for each county and element type using short-form DataFrames.

    Each DataFrame in short_form_dfs has:
      - Index: CNTYCODE (5-digit string)
      - Columns: YEAR (integers)
      - Values: Temperature in Fahrenheit

    Args:
        short_form_dfs: Dictionary with keys 'tmean', 'tmax', 'tmin'.

    Returns:
        Nested dict: {padded_id: {f'tslopeFPerDecade_{elem}': slope, f'tslopeStdErr_{elem}': std_err}}
    """
    slopes: dict[str, dict[str, float]] = {}

    # Get all unique county codes from any of the DataFrames
    all_counties: set[str] = set()
    for elem_name, elem_df in short_form_dfs.items():
        all_counties.update(elem_df.index.dropna())

    for noaa_id in sorted(all_counties):
        # Ensure we're working with a padded 5-char string to preserve leading zeros
        padded_id = str(noaa_id).zfill(5)
        noaa_state_code = int(padded_id[:2])

        # Skip counties with invalid (reserved/unused) state FIPS codes
        if noaa_state_code > 50:
            logger.warning(
                f'Encountered NOAA state-order code over 50: {noaa_state_code}')
            continue

        if not _is_valid_county(padded_id):
            continue

        if padded_id not in slopes:
            slopes[padded_id] = {}

        # Compute slopes for each temperature type using direct index lookup
        for elem_name in ['tmean', 'tmax', 'tmin']:
            if elem_name not in short_form_dfs:
                continue
            elem_df = short_form_dfs[elem_name]

            # Direct row lookup by index (fast!)
            if padded_id not in elem_df.index:
                continue

            year_row = elem_df.loc[padded_id]
            # Drop NaN values, then extract year/value pairs
            valid_data = year_row.dropna()
            if len(valid_data) < 2:
                slopes[padded_id][f'tslopeFPerDecade_{elem_name}'] = float(
                    'nan')
                slopes[padded_id][f'tslopeStdErr_{elem_name}'] = float('nan')
                continue

            years = valid_data.index.astype(int).tolist()
            values = valid_data.tolist()
            slope, std_err = compute_ols_slopes(pd.DataFrame(
                {'YEAR': years, 'VALUE': values}), value_col='VALUE')
            slopes[padded_id][f'tslopeFPerDecade_{elem_name}'] = slope
            slopes[padded_id][f'tslopeStdErr_{elem_name}'] = std_err

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
            logger.warning(f"County lookup file not found at {lookup_path}")
            logger.warning("Run create_county_lookup.py first to generate it.")
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


"""
Crosswalk between NOAA's climdiv STATE-CODE (positions 1-2 of every climdiv
county/divisional record) and real Census/FIPS state codes.

WHY THIS EXISTS
----------------
nClimDiv county and divisional files do NOT use FIPS state codes. They use a
legacy NOAA numbering scheme: the 48 contiguous states, numbered 01-48 in
straight alphabetical order, with Alaska and Hawaii excluded from the
sequence entirely (both were added to nClimDiv later - Alaska divisions in
2015, Hawaii divisions in 2025 - and are not slotted into the alphabetical
1-48 list). This is confirmed directly against NOAA/PSL's own climate
division reference (https://psl.noaa.gov/data/correlation/climdivisions.html),
which lists divisions in exactly this order with exactly 48 states and no
DC/AK/HI.

Naively treating STATE-CODE as a FIPS code silently produces wrong joins
(e.g. NOAA code 02 = Arizona, not FIPS 02 = Alaska; NOAA code 03 = Arkansas,
not FIPS 03 = unassigned).

WHAT THIS DOES NOT COVER
--------------------------
Alaska and Hawaii county-level coverage in nClimDiv. Because AK/HI aren't
part of the alphabetical 1-48 scheme, any STATE-CODE value outside 1-48
found in the raw county files needs to be investigated by hand before
assuming what it maps to - don't guess. `noaa_state_to_fips` raises on
anything outside 1-48 for exactly this reason, rather than returning a
best-effort answer.
"""

# NOAA climdiv state-order (01-50) -> (state name, FIPS state code).
# 1-48 verified against NOAA/PSL's divisional names reference (alphabetical,
# CONUS only). 49-50 taken directly from the official STATE CODE TABLE in
# https://www.ncei.noaa.gov/pub/data/cirs/climdiv/county-readme.txt, which
# assigns them out of alphabetical order: 49 = Hawaii, 50 = Alaska.
_NOAA_ORDER_TO_STATE: dict[int, tuple[str, str]] = {
    1: ("Alabama", "01"),
    2: ("Arizona", "04"),
    3: ("Arkansas", "05"),
    4: ("California", "06"),
    5: ("Colorado", "08"),
    6: ("Connecticut", "09"),
    7: ("Delaware", "10"),
    8: ("Florida", "12"),
    9: ("Georgia", "13"),
    10: ("Idaho", "16"),
    11: ("Illinois", "17"),
    12: ("Indiana", "18"),
    13: ("Iowa", "19"),
    14: ("Kansas", "20"),
    15: ("Kentucky", "21"),
    16: ("Louisiana", "22"),
    17: ("Maine", "23"),
    18: ("Maryland", "24"),
    19: ("Massachusetts", "25"),
    20: ("Michigan", "26"),
    21: ("Minnesota", "27"),
    22: ("Mississippi", "28"),
    23: ("Missouri", "29"),
    24: ("Montana", "30"),
    25: ("Nebraska", "31"),
    26: ("Nevada", "32"),
    27: ("New Hampshire", "33"),
    28: ("New Jersey", "34"),
    29: ("New Mexico", "35"),
    30: ("New York", "36"),
    31: ("North Carolina", "37"),
    32: ("North Dakota", "38"),
    33: ("Ohio", "39"),
    34: ("Oklahoma", "40"),
    35: ("Oregon", "41"),
    36: ("Pennsylvania", "42"),
    37: ("Rhode Island", "44"),
    38: ("South Carolina", "45"),
    39: ("South Dakota", "46"),
    40: ("Tennessee", "47"),
    41: ("Texas", "48"),
    42: ("Utah", "49"),
    43: ("Vermont", "50"),
    44: ("Virginia", "51"),
    45: ("Washington", "53"),
    46: ("West Virginia", "54"),
    47: ("Wisconsin", "55"),
    48: ("Wyoming", "56"),
    49: ("Hawaii", "15"),
    50: ("Alaska", "02"),
}


def noaa_state_to_fips(noaa_state_code: Union[str, int]) -> str:
    """
    Convert a NOAA climdiv STATE-CODE (as it appears in raw file records,
    e.g. "02" or 2) to a real 2-digit FIPS state code (e.g. "04" for
    Arizona).

    Raises ValueError for anything outside 1-48, rather than guessing -
    that range is where Alaska/Hawaii or a genuine parsing error would show
    up, and both deserve a human looking at the raw record, not a silent
    fallback.
    """
    code = int(noaa_state_code)
    if code not in _NOAA_ORDER_TO_STATE:
        raise ValueError(
            f"NOAA state-order code {code!r} is outside the known 1-50 "
            "alphabetical range. This is Washington DC (not part of "
            "the alphabetical scheme) or a parsing error - do not guess a "
            "mapping, inspect the raw record."
        )
    _, fips = _NOAA_ORDER_TO_STATE[code]
    return fips


def noaa_state_name(noaa_state_code: Union[str, int]) -> str:
    """Convenience lookup for the state name, same rules as noaa_state_to_fips."""
    code = int(noaa_state_code)
    if code not in _NOAA_ORDER_TO_STATE:
        raise ValueError(
            f"NOAA state-order code {code!r} is outside the known 1-48 range."
        )
    name, _ = _NOAA_ORDER_TO_STATE[code]
    return name


def _load_short_form_dfs(raw_dir: Path) -> dict[str, pd.DataFrame]:
    """Load three short-form CSV files from the raw directory.

    Each CSV has CNTYCODE as the first column (index), years as subsequent columns.
    """
    dfs: dict[str, pd.DataFrame] = {}
    for elem_name in ['tmean', 'tmax', 'tmin']:
        csv_path = raw_dir / f"annual_{elem_name}.csv"
        if not csv_path.exists():
            raise FileNotFoundError(
                f"Expected short-form CSV not found: {csv_path}")
        # Read with CNTYCODE as string, parse index column
        df = pd.read_csv(csv_path, dtype={'CNTYCODE': str})
        df = df.set_index('CNTYCODE')
        # Convert column names to integers
        df.columns = df.columns.astype(int)
        dfs[elem_name] = df
    return dfs


def _save_short_form_dfs(dfs: dict[str, pd.DataFrame], raw_dir: Path) -> None:
    """Save three short-form DataFrames to individual CSV files."""
    for elem_name, df in dfs.items():
        csv_path = raw_dir / f"annual_{elem_name}.csv"
        df.to_csv(csv_path)
        logger.info(
            f"Saved {csv_path} ({len(df)} counties, {len(df.columns)} years)")


def parse_args():
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Process NOAA county climate data into datasets."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        default=False,
        help="Force regeneration of cached short-form CSV files, ignoring existing cache."
    )
    return parser.parse_args()


def main():
    """Main function to process NOAA county climate data."""
    logger.info("Starting data processing...")

    # Parse command-line arguments
    args = parse_args()
    force_regenerate = getattr(args, 'force', False)

    # Read all raw files
    raw_dir = Path(__file__).parent / "raw"
    short_form_paths = [
        raw_dir / f"annual_{elem}.csv" for elem in ['tmean', 'tmax', 'tmin']]

    # Use cache only if files exist AND --force flag is not set
    use_cache = all(p.exists()
                    for p in short_form_paths) and not force_regenerate
    if use_cache:
        logger.info('Using cached short-form CSVs. Load them.')
    else:
        if force_regenerate:
            logger.info(
                '--force flag set. Regenerating short-form CSVs from raw climdiv files.')
        else:
            logger.debug('Reading climdiv files')
        df = read_raw_files()
        logger.info(f"Read {len(df)} records")

        logger.debug('Aggregating climdiv data into short-form DataFrames')
        short_form_dfs = aggregate_to_short_form_dfs(df)
        logger.info(
            f"Short-form: tmean={len(short_form_dfs['tmean'])}x{len(short_form_dfs['tmean'].columns)}")

        # Save short-form DataFrames to CSV
        _save_short_form_dfs(short_form_dfs, raw_dir)

    if use_cache:
        logger.info('Loading cached short-form CSVs.')
        short_form_dfs = _load_short_form_dfs(raw_dir)

    # Get global year range from data
    all_years: set[int] = set()
    for elem_df in short_form_dfs.values():
        all_years.update(elem_df.columns.astype(int).tolist())
    min_year = min(all_years)
    max_year = max(all_years)
    logger.info(f"Year range: {min_year}-{max_year}")

    # Compute slopes using optimized short-form method
    slopes = compute_slopes_per_county(short_form_dfs)
    logger.info(f"Computed slopes for {len(slopes)} counties")

    # Collect all unique county NOAA IDs from short-form indices
    all_counties: set[str] = set()
    for elem_df in short_form_dfs.values():
        all_counties.update(elem_df.index.dropna().astype(str).tolist())

    # Create metadata dictionary keyed by FIPS
    meta_data: dict[str, dict] = {}
    series_data: dict = {
        "startYear": min_year,
        "series": {}
    }

    # Process each county to build metadata and series using short-form lookups
    for noaa_id in sorted(all_counties):
        # Ensure we're working with a padded 5-char string to preserve leading zeros.
        padded_id = str(noaa_id).zfill(5)

        # NOAA has its own legacy code system that differs from FIPS
        noaa_state_code = int(padded_id[:2])
        noaa_county_code = padded_id[2:]

        if noaa_state_code > 50:
            logger.warning(
                f'Encountered NOAA state-order code over 50: {noaa_state_code}')
            continue

        if not _is_valid_county(padded_id):
            continue

        fips_state = noaa_state_to_fips(noaa_state_code)

        # Build the full FIPS code by combining the converted FIPS state code
        # with the original county code from the NOAA ID
        fips = fips_state + noaa_county_code

        # Get county name and state
        name, state = get_county_info_from_fips(fips)

        # Build metadata entry
        meta_entry: dict[str, str | float] = {
            "name": name,
            "state": state
        }

        # Add slope values if available
        if padded_id in slopes:
            for key, value in slopes[padded_id].items():
                meta_entry[key] = value

        meta_data[fips] = meta_entry

        # Build series data using short-form lookups (fast!)
        # Find all years where at least one element has data for this county
        year_sets: list[set[int]] = []
        for elem_df in short_form_dfs.values():
            if padded_id in elem_df.index:
                valid_years = set(
                    elem_df.loc[padded_id].dropna().index.astype(int))
                year_sets.append(valid_years)

        if year_sets:
            # Union of all years with any data
            all_county_years = sorted(set().union(*year_sets))

            # Extract values for each element at these specific years
            series_entry: dict[str, list[int | None]] = {
                "tmean": [],
                "tmax": [],
                "tmin": []
            }

            tmean_df = short_form_dfs.get('tmean', pd.DataFrame())
            tmax_df = short_form_dfs.get('tmax', pd.DataFrame())
            tmin_df = short_form_dfs.get('tmin', pd.DataFrame())

            for year in all_county_years:
                # tmean
                if year in tmean_df.columns and padded_id in tmean_df.index:
                    val = tmean_df.loc[padded_id, year]
                    series_entry["tmean"].append(
                        int(val * 10) if pd.notna(val) else None)
                else:
                    series_entry["tmean"].append(None)

                # tmax
                if year in tmax_df.columns and padded_id in tmax_df.index:
                    val = tmax_df.loc[padded_id, year]
                    series_entry["tmax"].append(
                        int(val * 10) if pd.notna(val) else None)
                else:
                    series_entry["tmax"].append(None)

                # tmin
                if year in tmin_df.columns and padded_id in tmin_df.index:
                    val = tmin_df.loc[padded_id, year]
                    series_entry["tmin"].append(
                        int(val * 10) if pd.notna(val) else None)
                else:
                    series_entry["tmin"].append(None)

            series_data["series"][fips] = series_entry

    # Compute slope domains (percentiles)
    slope_domains: dict[str, list[float]] = {
        "tmean": [-1.0, 1.0],
        "tmax": [-1.0, 1.0],
        "tmin": [-1.0, 1.0]
    }

    # Collect slopes by type for computing percentiles
    tmean_slopes: list[float] = []
    tmax_slopes: list[float] = []
    tmin_slopes: list[float] = []
    dtr_slopes: list[float] = []

    for fips_val, meta in meta_data.items():
        for key, value in meta.items():
            if key.startswith('tslopeFPerDecade_'):
                if isinstance(value, (int, float)) and np.isfinite(value):
                    if key == 'tslopeFPerDecade_tmean':
                        tmean_slopes.append(float(value))
                    elif key == 'tslopeFPerDecade_tmax':
                        tmax_slopes.append(float(value))
                    elif key == 'tslopeFPerDecade_tmin':
                        tmin_slopes.append(float(value))

    # Compute DTR slopes and their percentiles
    for padded_id, slope_dict in slopes.items():
        max_slope = slope_dict.get('tslopeFPerDecade_tmax')
        min_slope = slope_dict.get('tslopeFPerDecade_tmin')
        if (isinstance(max_slope, (int, float)) and np.isfinite(max_slope) and
                isinstance(min_slope, (int, float)) and np.isfinite(min_slope)):
            dtr_slope = max_slope - min_slope
            dtr_slopes.append(float(dtr_slope))

    # Compute percentiles for each type
    if tmean_slopes:
        slope_domains["tmean"] = np.percentile(
            tmean_slopes, [1, 99]).tolist()

    if tmax_slopes:
        slope_domains["tmax"] = np.percentile(
            tmax_slopes, [1, 99]).tolist()

    if tmin_slopes:
        slope_domains["tmin"] = np.percentile(
            tmin_slopes, [1, 99]).tolist()

    # Compute DTR domain (symmetric around 0, using absolute values)
    if dtr_slopes:
        abs_dtr = [abs(d) for d in dtr_slopes]
        extent = float(np.percentile(abs_dtr, 99))
        slope_domains["dtr"] = [-extent, extent]

    # Add domains to metadata
    meta_data_with_domains = {
        "generatedAt": datetime.now().isoformat(),
        "sourceYearRange": [min_year, max_year],
        "slopeDomains": slope_domains,
        "counties": meta_data
    }

    # Write output files (relative to repo root)
    _REPO_ROOT = _SCRIPT_DIR.parent
    output_dir = _REPO_ROOT / "public" / "data"
    output_dir.mkdir(parents=True, exist_ok=True)

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

    meta_path = output_dir / "counties.meta.json"
    series_path = output_dir / "counties.series.json"

    with open(meta_path, "w") as f:
        json.dump(meta_data_with_domains_serializable, f, indent=2)
    logger.info(f"Wrote {meta_path} ({len(meta_data)} counties)")

    with open(series_path, "w") as f:
        json.dump(series_data_serializable, f, indent=2)
    logger.info(f"Wrote {series_path}")

    logger.info("Processing complete!")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Create a comprehensive FIPS county code to name lookup table from Census Bureau
county code reference files.

This script:
1. Downloads state/territory-specific county files from the Census Bureau's
   TIGER/Line Reference Guide (2020 edition)
2. Stores raw .txt files in data-pipeline/raw/counties/ (one per state)
3. Post-processes all raw files to create a JSON lookup table

The resulting lookup table maps 5-digit FIPS codes (STATEFP + COUNTYFP) to:
- County name
- State abbreviation
- State full name

This is used by process_to_dataset.py to label counties with proper names.

Source URLs follow the pattern:
https://www2.census.gov/geo/docs/reference/codes2020/cou/st{XX}_{ABBR}_cou2020.txt
"""

import json
import time
from pathlib import Path
import requests


# Complete state/territory mapping: FIPS -> {abbr, name}
STATE_METADATA = {
    "01": {"abbr": "AL", "name": "Alabama"},
    "02": {"abbr": "AK", "name": "Alaska"},
    "04": {"abbr": "AZ", "name": "Arizona"},
    "05": {"abbr": "AR", "name": "Arkansas"},
    "06": {"abbr": "CA", "name": "California"},
    "08": {"abbr": "CO", "name": "Colorado"},
    "09": {"abbr": "CT", "name": "Connecticut"},
    "10": {"abbr": "DE", "name": "Delaware"},
    "11": {"abbr": "DC", "name": "District of Columbia"},
    "12": {"abbr": "FL", "name": "Florida"},
    "13": {"abbr": "GA", "name": "Georgia"},
    "15": {"abbr": "HI", "name": "Hawaii"},
    "16": {"abbr": "ID", "name": "Idaho"},
    "17": {"abbr": "IL", "name": "Illinois"},
    "18": {"abbr": "IN", "name": "Indiana"},
    "19": {"abbr": "IA", "name": "Iowa"},
    "20": {"abbr": "KS", "name": "Kansas"},
    "21": {"abbr": "KY", "name": "Kentucky"},
    "22": {"abbr": "LA", "name": "Louisiana"},
    "23": {"abbr": "ME", "name": "Maine"},
    "24": {"abbr": "MD", "name": "Maryland"},
    "25": {"abbr": "MA", "name": "Massachusetts"},
    "26": {"abbr": "MI", "name": "Michigan"},
    "27": {"abbr": "MN", "name": "Minnesota"},
    "28": {"abbr": "MS", "name": "Mississippi"},
    "29": {"abbr": "MO", "name": "Missouri"},
    "30": {"abbr": "MT", "name": "Montana"},
    "31": {"abbr": "NE", "name": "Nebraska"},
    "32": {"abbr": "NV", "name": "Nevada"},
    "33": {"abbr": "NH", "name": "New Hampshire"},
    "34": {"abbr": "NJ", "name": "New Jersey"},
    "35": {"abbr": "NM", "name": "New Mexico"},
    "36": {"abbr": "NY", "name": "New York"},
    "37": {"abbr": "NC", "name": "North Carolina"},
    "38": {"abbr": "ND", "name": "North Dakota"},
    "39": {"abbr": "OH", "name": "Ohio"},
    "40": {"abbr": "OK", "name": "Oklahoma"},
    "41": {"abbr": "OR", "name": "Oregon"},
    "42": {"abbr": "PA", "name": "Pennsylvania"},
    "44": {"abbr": "RI", "name": "Rhode Island"},
    "45": {"abbr": "SC", "name": "South Carolina"},
    "46": {"abbr": "SD", "name": "South Dakota"},
    "47": {"abbr": "TN", "name": "Tennessee"},
    "48": {"abbr": "TX", "name": "Texas"},
    "49": {"abbr": "UT", "name": "Utah"},
    "50": {"abbr": "VT", "name": "Vermont"},
    "51": {"abbr": "VA", "name": "Virginia"},
    "53": {"abbr": "WA", "name": "Washington"},
    "54": {"abbr": "WV", "name": "West Virginia"},
    "55": {"abbr": "WI", "name": "Wisconsin"},
    "56": {"abbr": "WY", "name": "Wyoming"},
    # Territories
    "60": {"abbr": "AS", "name": "American Samoa"},
    "66": {"abbr": "GU", "name": "Guam"},
    "69": {"abbr": "MP", "name": "Northern Mariana Islands"},
    "72": {"abbr": "PR", "name": "Puerto Rico"},
    "74": {"abbr": "UM", "name": "U.S. Minor Outlying Islands"},
    "78": {"abbr": "VI", "name": "Virgin Islands"},
}


def get_state_info(state_fips: str) -> tuple[str, str]:
    """Get state abbreviation and full name from FIPS code.

    Args:
        state_fips: 2-digit state FIPS code

    Returns:
        Tuple of (state_abbreviation, state_full_name)
    """
    info = STATE_METADATA.get(state_fips, {"abbr": "XX", "name": "Unknown"})
    return (info["abbr"], info["name"])


def download_county_files(raw_dir: Path) -> list[str]:
    """Download county reference files from Census Bureau for all states/territories.

    Downloads state-specific .txt files containing county names and FIPS codes.
    Skips already-downloaded files for idempotency.

    Args:
        raw_dir: Directory to save downloaded files (data-pipeline/raw/counties/)

    Returns:
        List of successfully downloaded filenames
    """
    base_url = "https://www2.census.gov/geo/docs/reference/codes2020/cou/"

    # Define all state/territory files to download
    states_to_download = [
        ("st01_al_cou2020.txt", "01"),  # Alabama
        ("st02_ak_cou2020.txt", "02"),  # Alaska
        ("st04_az_cou2020.txt", "04"),  # Arizona
        ("st05_ar_cou2020.txt", "05"),  # Arkansas
        ("st06_ca_cou2020.txt", "06"),  # California
        ("st08_co_cou2020.txt", "08"),  # Colorado
        ("st09_ct_cou2020.txt", "09"),  # Connecticut
        ("st10_de_cou2020.txt", "10"),  # Delaware
        ("st11_dc_cou2020.txt", "11"),  # District of Columbia
        ("st12_fl_cou2020.txt", "12"),  # Florida
        ("st13_ga_cou2020.txt", "13"),  # Georgia
        ("st15_hi_cou2020.txt", "15"),  # Hawaii
        ("st16_id_cou2020.txt", "16"),  # Idaho
        ("st17_il_cou2020.txt", "17"),  # Illinois
        ("st18_in_cou2020.txt", "18"),  # Indiana
        ("st19_ia_cou2020.txt", "19"),  # Iowa
        ("st20_ks_cou2020.txt", "20"),  # Kansas
        ("st21_ky_cou2020.txt", "21"),  # Kentucky
        ("st22_la_cou2020.txt", "22"),  # Louisiana
        ("st23_me_cou2020.txt", "23"),  # Maine
        ("st24_md_cou2020.txt", "24"),  # Maryland
        ("st25_ma_cou2020.txt", "25"),  # Massachusetts
        ("st26_mi_cou2020.txt", "26"),  # Michigan
        ("st27_mn_cou2020.txt", "27"),  # Minnesota
        ("st28_ms_cou2020.txt", "28"),  # Mississippi
        ("st29_mo_cou2020.txt", "29"),  # Missouri
        ("st30_mt_cou2020.txt", "30"),  # Montana
        ("st31_ne_cou2020.txt", "31"),  # Nebraska
        ("st32_nv_cou2020.txt", "32"),  # Nevada
        ("st33_nh_cou2020.txt", "33"),  # New Hampshire
        ("st34_nj_cou2020.txt", "34"),  # New Jersey
        ("st35_nm_cou2020.txt", "35"),  # New Mexico
        ("st36_ny_cou2020.txt", "36"),  # New York
        ("st37_nc_cou2020.txt", "37"),  # North Carolina
        ("st38_nd_cou2020.txt", "38"),  # North Dakota
        ("st39_oh_cou2020.txt", "39"),  # Ohio
        ("st40_ok_cou2020.txt", "40"),  # Oklahoma
        ("st41_or_cou2020.txt", "41"),  # Oregon
        ("st42_pa_cou2020.txt", "42"),  # Pennsylvania
        ("st44_ri_cou2020.txt", "44"),  # Rhode Island
        ("st45_sc_cou2020.txt", "45"),  # South Carolina
        ("st46_sd_cou2020.txt", "46"),  # South Dakota
        ("st47_tn_cou2020.txt", "47"),  # Tennessee
        ("st48_tx_cou2020.txt", "48"),  # Texas
        ("st49_ut_cou2020.txt", "49"),  # Utah
        ("st50_vt_cou2020.txt", "50"),  # Vermont
        ("st51_va_cou2020.txt", "51"),  # Virginia
        ("st53_wa_cou2020.txt", "53"),  # Washington
        ("st54_wv_cou2020.txt", "54"),  # West Virginia
        ("st55_wi_cou2020.txt", "55"),  # Wisconsin
        ("st56_wy_cou2020.txt", "56"),  # Wyoming
        # Territories
        ("st60_as_cou2020.txt", "60"),  # American Samoa
        ("st66_gu_cou2020.txt", "66"),  # Guam
        ("st69_mp_cou2020.txt", "69"),  # Northern Mariana Islands
        ("st72_pr_cou2020.txt", "72"),  # Puerto Rico
        ("st74_um_cou2020.txt", "74"),  # U.S. Minor Outlying Islands
        ("st78_vi_cou2020.txt", "78"),  # Virgin Islands
    ]

    raw_dir.mkdir(exist_ok=True)

    downloaded = []
    skipped = []
    failed = []

    for filename, _ in states_to_download:
        filepath = raw_dir / filename

        # Skip if already exists
        if filepath.exists():
            print(f"  Skipping (exists): {filename}")
            skipped.append(filename)
            continue

        url = base_url + filename

        try:
            print(f"  Downloading: {filename}...")
            response = requests.get(url, timeout=60)

            if response.status_code == 200:
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(response.text)
                downloaded.append(filename)
                print(f"    Saved to {filepath}")
            else:
                print(f"    Failed: HTTP {response.status_code}")
                failed.append(filename)

        except requests.RequestException as e:
            print(f"    Error: {e}")
            failed.append(filename)

        # Rate limiting - be gentle with Census servers
        time.sleep(0.2)

    print(f"\nDownloaded: {len(downloaded)} files")
    print(f"Skipped: {len(skipped)} files")
    if failed:
        print(f"Failed: {len(failed)} files: {failed}")

    return downloaded


def parse_county_file(filepath: Path) -> dict[str, dict]:
    """Parse a single state's county reference file.

    Args:
        filepath: Path to the .txt file (pipe-delimited format)

    Returns:
        Dictionary mapping 5-digit FIPS codes to county info
    """
    lookup = {}

    with open(filepath, "r", encoding="utf-8") as f:
        lines = f.readlines()

    if not lines:
        return lookup

    # Skip header line
    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue

        parts = line.split("|")

        if len(parts) >= 5:
            state_fips = parts[1].strip().zfill(2)
            county_fips = parts[2].strip().zfill(3)
            county_name = parts[4].strip()

            # Create 5-digit FIPS key (STATEFP + COUNTYFP)
            fips_key = state_fips + county_fips

            # Clean up county name: remove " County", "Municipio", etc. suffixes
            clean_name = county_name
            for suffix in [" County", " Borough", " city", " City",
                           " Parish", " Municipios", " Municipio"]:
                if clean_name.endswith(suffix):
                    clean_name = clean_name[:-len(suffix)]
                    break

            # Get state info
            state_abbr, _ = get_state_info(state_fips)

            lookup[fips_key] = {
                "name": clean_name,
                "state": state_abbr
            }

    return lookup


def create_lookup_json(counties_dir: Path, output_path: Path) -> dict[str, dict]:
    """Post-process all downloaded county files into a single JSON lookup table.

    Args:
        counties_dir: Directory containing the downloaded .txt files
        output_path: Path to write the resulting JSON file

    Returns:
        The complete lookup dictionary
    """
    # Find all .txt files in counties directory
    txt_files = list(counties_dir.glob("*.txt"))

    if not txt_files:
        print(f"No county files found in {counties_dir}")
        return {}

    print(f"\nProcessing {len(txt_files)} county reference files...")

    # Combine all lookups into a single dictionary
    combined_lookup = {}

    for filepath in sorted(txt_files):
        print(f"  Processing: {filepath.name}")
        file_lookup = parse_county_file(filepath)
        combined_lookup.update(file_lookup)

    # Sort by FIPS key and write to JSON
    sorted_lookup = dict(sorted(combined_lookup.items()))

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(sorted_lookup, f, indent=2)

    print(f"\nCreated lookup table with {len(sorted_lookup)} counties")
    print(f"Wrote to {output_path}")

    return sorted_lookup


def main():
    """Main function to create county lookup table."""
    script_dir = Path(__file__).parent

    print("=== Creating County Lookup Table from Census Bureau Files ===\n")

    # Step 1: Download county reference files
    counties_dir = script_dir / "raw" / "counties"
    print(f"\nStep 1: Downloading county reference files to {counties_dir}\n")

    downloaded = download_county_files(counties_dir)

    if not downloaded and not list(counties_dir.glob("*.txt")):
        print("\nError: No county files were downloaded or found")
        return

    # Step 2: Post-process into JSON lookup table
    output_path = script_dir / "county_lookup.json"
    print(f"\nStep 2: Creating lookup JSON...")

    lookup = create_lookup_json(counties_dir, output_path)

    if not lookup:
        print("\nError: Failed to create lookup table")
        return

    print(f"\n=== Complete ===")


if __name__ == "__main__":
    main()

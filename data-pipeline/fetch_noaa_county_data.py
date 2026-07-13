"""
Downloads raw NOAA NCEI county-level climate division files (nClimDiv-derived
max/min temperature, monthly, 1895-present) into data-pipeline/raw/.

Source: https://www.ncei.noaa.gov/pub/data/cirs/climdiv/
See data-pipeline/README.md for the file naming/codebook reference.

Downloads the latest version of:
- climdiv-tmaxcy-* (max temperature)
- climdiv-tmincy-* (min temperature) 
- climdiv-tmpccy-* (average temperature)

General guide for pulling and processing this data: https://atcoordinates.info/2024/04/14/historic-county-climate-data-for-the-us/

"""

import os
import re
import requests
from pathlib import Path


def get_latest_files(base_url: str) -> dict[str, str]:
    """Fetch directory listing and find latest version of each required file."""
    try:
        response = requests.get(base_url)
        response.raise_for_status()

        # Parse HTML to find all climdiv files
        html_content = response.text

        # Extract filenames with full URLs for the specific county files we want
        file_urls = {}

        # Match the specific patterns we're looking for - simpler approach
        # The href attribute contains the exact filename
        tmaxcy_pattern = r'<a href="climdiv-tmaxcy-v([^"]+)">climdiv-tmaxcy-v\1</a>'
        tmincy_pattern = r'<a href="climdiv-tmincy-v([^"]+)">climdiv-tmincy-v\1</a>'
        tmpccy_pattern = r'<a href="climdiv-tmpccy-v([^"]+)">climdiv-tmpccy-v\1</a>'

        # Extract each file type
        for pattern, file_type in [(tmaxcy_pattern, "tmaxcy"), (tmincy_pattern, "tmincy"), (tmpccy_pattern, "tmpccy")]:
            match = re.search(pattern, html_content)
            if match:
                filename = f"climdiv-{file_type}-v{match.group(1)}"
                url = base_url + filename
                file_urls[file_type] = url

        return file_urls

    except requests.RequestException as e:
        print(f"Error fetching directory listing: {e}")
        raise


def download_file(url: str, filepath: Path) -> None:
    """Download a single file with progress indication."""
    try:
        print(f"Downloading {url}...")
        response = requests.get(url, stream=True)
        response.raise_for_status()

        with open(filepath, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)

        print(f"Downloaded: {filepath}")

    except requests.RequestException as e:
        print(f"Error downloading {url}: {e}")
        raise


def main() -> None:
    """Main function to download NOAA county climate data."""
    # Create raw directory if it doesn't exist
    raw_dir = Path("./raw")
    raw_dir.mkdir(exist_ok=True)

    base_url = "https://www.ncei.noaa.gov/pub/data/cirs/climdiv/"

    print("Fetching latest NOAA NCEI county climate files...")

    # Get the latest versions of each required file
    try:
        latest_files = get_latest_files(base_url)

        # Files we need to download
        required_files = ["tmaxcy", "tmincy", "tmpccy"]
        downloaded_count = 0

        for file_type in required_files:
            if file_type in latest_files:
                url = latest_files[file_type]
                filename = url.split("/")[-1]  # Extract filename from URL
                filepath = raw_dir / filename

                print(f"Downloading {file_type} data...")
                download_file(url, filepath)
                downloaded_count += 1
            else:
                print(f"Warning: Could not find latest {file_type} file")

        if downloaded_count == 0:
            raise RuntimeError("No files were successfully downloaded")

        print(
            f"Successfully downloaded {downloaded_count} NOAA climate data files")

    except Exception as e:
        print(f"Error in main execution: {e}")
        raise


if __name__ == "__main__":
    main()

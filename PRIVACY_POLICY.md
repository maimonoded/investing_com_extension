# Privacy Policy for Investing.com Portfolio Overlay

**Last updated:** December 2025

## Overview

Investing.com Portfolio Overlay is a browser extension that displays your portfolio holdings on investing.com asset pages. This policy explains how the extension handles your data.

## Data Collection

**This extension does NOT collect any personal data.**

The extension:
- Reads portfolio data directly from investing.com when you visit the site
- Stores portfolio data locally in your browser for caching purposes
- Does NOT send any data to external servers
- Does NOT use analytics or tracking
- Does NOT access your cookies, passwords, or login credentials

## How It Works

1. When you visit investing.com, the extension fetches your portfolio data from investing.com's servers (using your existing logged-in session)
2. This data is cached locally in your browser to improve performance
3. When you view an asset page, the extension displays your position information directly on the page

## Data Storage

All data is stored locally in your browser using Chrome's storage API (`chrome.storage.local`). This data:
- Never leaves your browser
- Is automatically cleared when you uninstall the extension
- Can be manually cleared using the "Clear All Data" button in the extension popup

## Permissions

The extension requires the following permissions:
- **storage**: To cache portfolio data locally for performance
- **alarms**: To periodically refresh cached data
- **host_permissions (investing.com)**: To read portfolio data and display position information on asset pages

## Third Parties

This extension does NOT share any data with third parties.

## Contact

For questions about this privacy policy, please open an issue on the project's GitHub repository.

## Disclaimer

This extension was created for personal use and is provided "AS IS" without warranty of any kind. This extension is not affiliated with, endorsed by, or associated with investing.com in any way.

## Changes

Any changes to this privacy policy will be reflected in this document with an updated date.

# Mud Fever Sales Report — GitHub Version

This repo replaces the Google Apps Script version with:

- `index.html`: static dashboard for GitHub Pages.
- `scripts/generate-report-data.js`: Node.js Shopify backend that generates `data/report-data.json`.
- `.github/workflows/update-report.yml`: GitHub Actions workflow that runs the backend using GitHub Secrets and Variables.

## 1) Upload files to GitHub

Create a new GitHub repository and upload all files/folders in this package:

```text
.github/workflows/update-report.yml
scripts/generate-report-data.js
data/report-data.json
index.html
package.json
README.md
.gitignore
```

## 2) Add Shopify credentials in GitHub

Go to your repository:

**Settings → Secrets and variables → Actions**

### Secrets

Create these under **Secrets**:

| Name | Value |
|---|---|
| `SHOPIFY_STORE` | `your-store.myshopify.com` |
| `SHOPIFY_TOKEN` | `shpat_xxxxxxxxx` |

### Variables

Create these under **Variables** as needed:

| Name | Example | Required? |
|---|---:|---|
| `SHOPIFY_API_VERSION` | `2024-01` | No |
| `MUD_FEVER_INITIAL_STOCK_RECEIVED` | `500` | No |
| `MUD_FEVER_STOCK_RECEIVED_DATE` | `2026-03-01` | No |
| `MUD_FEVER_SKU` | `MF-001` | No |
| `MUD_FEVER_LOCATION_ID` | `63267766330` | No |
| `MUD_FEVER_LOCATION_NAME` | `New Wellington Warehouse` | No |
| `MUD_FEVER_WHOLESALE_PRICE` | `12.50` | No |
| `MUD_FEVER_DEDUCT_MARKETING_SHIPPING` | `true` | No |

Required Shopify app permissions:

- `read_orders`
- `read_products`
- `read_inventory`

## 3) Run the report generator

Go to:

**Actions → Update Mud Fever Report Data → Run workflow**

The workflow will:

1. Connect to Shopify using the Secrets.
2. Generate reports for recent weeks, months, and quarters.
3. Save the output to `data/report-data.json`.
4. Commit the updated JSON file back to the repo.

## 4) Enable GitHub Pages

Go to:

**Settings → Pages**

Use:

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/root`

Then open the GitHub Pages URL. The dashboard reads `data/report-data.json`; it does not expose the Shopify token in the browser.

## Important security note

Do not put `SHOPIFY_TOKEN` inside `index.html` or any public JavaScript file. GitHub Pages is public/static, so Shopify API calls must happen in GitHub Actions, not in the browser.

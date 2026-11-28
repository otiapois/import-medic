# Amazon Price & Quantity flat files

The [Amazon adapter](../../src/core/amazon-price-diff/) compares one local legacy Price & Quantity baseline with one proposal file. It accepts comma-delimited CSV and tab-delimited TSV or TXT. Use the existing Price Update Studio under **Amazon Seller Central**. The local CLI uses `--platform amazon`. [CLI build and verify options](cli-automation.md#amazon-price-diff)

## Inputs and writes

The baseline uses the original `sku` text as the listing identity. The supported value columns are `price` and `quantity`. `minimum-seller-allowed-price` and `maximum-seller-allowed-price` on the baseline supply price limits. Other baseline fields such as `handling-time` remain part of the local catalog data. The proposal uses `sku` and at least one of `price` or `quantity`. A textual SKU such as `0001` retains its leading zeros and is distinct from `1`.

The adapter holds a price below a supplied minimum, a price above a supplied maximum, invalid bounds, and a minimum greater than the maximum. The bounds are inclusive. A blank or absent limit means the local file supplies no evidence for that bound. A write also requires a restorable original value. If the baseline identifies an Amazon-fulfilled offer in `fulfillment-channel`, a quantity write holds with `amazon-fba-quantity`. Issues identify the original physical line in each supplied file where the affected row occurs. Review reported lines and correct the source before regenerating a held pair.

The update and matching rollback use the baseline delimiter. They carry `sku` and scoped `price` or `quantity` writes for eligible changes. A rollback writes the original cell text for each changed value. The price limits, handling time, fulfillment details, and other untouched cells remain in the catalog during local replay. The replay compares the reconstructed catalog's parsed cells against the original, with source and downloaded file fingerprints computed from their own bytes.

## Verify before import

The standalone inspector accepts the original baseline and a candidate in the same delimiter. It checks exact SKUs, permitted fields, value rules and the supplied price limits, then reports `PASS` or `FAIL_UNSAFE` with findings and SHA-256 fingerprints. With an actual matching update supplied, the inspector applies the update and rollback in sequence and checks recovery of the full original catalog data. With only a baseline and rollback, the inspector can check the included values against the baseline.

The local check covers the supplied flat files. Verify the upload format, existing offers, and fulfillment rules in the destination Seller Central account before importing. Amazon's legacy documentation describes tab-delimited preparation and directs Amazon-fulfilled offers to leave quantity empty. Seller Central also offers a separately generated `.xlsx` Price & Quantity template. The adapter supports the legacy flat-file schema and has no connection to Amazon accounts, marketplaces, or FBA. [Legacy Price & Quantity file](https://sellercentral.amazon.com/help/hub/reference/external/G200385490?locale=en-US) · [Tab-delimited file preparation](https://sellercentral.amazon.com/help/hub/reference/external/G200388940?locale=en-US) · [Generated Price & Quantity template](https://sellercentral.amazon.com/help/hub/reference/external/GP2SE99TZ8SLDS7G?locale=en-US)

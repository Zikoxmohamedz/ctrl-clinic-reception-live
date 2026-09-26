# Reporting design and source coverage

Reviewed official product references on 2026-09-26:

- [Zoho Inventory reports](https://www.zoho.com/us/inventory/help/reports/inventory-reports.html): inventory summary, opening/in/out/closing stock, replenishment, counts and aging.
- [Zoho reports overview](https://www.zoho.com/us/inventory/help/reports/reports-overview.html): report centre, valuation and ABC categories.
- [Odoo stock report](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/warehouses_storage/reporting/stock.html): product stock and forecast drill-down.
- [Odoo inventory aging](https://www.odoo.com/documentation/17.0/applications/inventory_and_mrp/inventory/warehouses_storage/reporting/aging.html): aging as an inventory investigation.

The clinic app now has 20 reports and an interactive dashboard. Existing accounting reports remain available. Added: branch comparisons, daily transactions/revenue, days of stock coverage and configurable replenishment scenarios, items without recorded client consumption, revenue-based ABC, expiry alerts, count coverage and data-quality exceptions.

The dashboard uses the same applied filters and reviewed report rows as Excel and print. It appears on Home only for accounts with reports, inventory and inventory-report permissions. Other users retain the reception home. There is no public data snapshot bundled with the website: the existing authenticated Supabase RPC loads authorized branches.

## Supported definitions

- Grain of balances and replenishment: branch + material. Units are never summed across different materials in dashboard KPIs.
- Client revenue excludes outgoing transfers. Daily and branch revenue reconcile to consumption rows in the applied period.
- Coverage: closing book quantity divided by mean recorded daily client consumption. A configurable 7/14/30/60-day target changes an estimate, not stock records. Unknown or negative balances and zero observed demand do not generate a purchase quantity.
- ABC: ranked client revenue across filtered branches/materials; cumulative bands A 80%, B 95%, C remaining. The item crossing a threshold remains in the band it starts in. Zero-revenue items are unclassified. This is not cost-based ABC or profitability.
- Dormancy: positive book balance with no client consumption in the selected period. Last recorded consumption date is shown when available. This is not true lot aging.
- Valuation: current catalog cost multiplied by known nonnegative balances. Missing cost and invalid balances are counted as exclusions; a wholly unavailable valuation is not displayed as zero in the dashboard.
- Count coverage: material/branch pairs counted in completed sessions during the period divided by scoped material/branch pairs. Open sessions do not establish stock.
- Expiry alerts: last physical-count batch dates per material, evaluated as of the report end date; quantities remain historical count observations.

## Deliberately unsupported

Supplier aging, receivables/payables, purchase commitments, exact FIFO/weighted-average valuation, true batch stock aging, historical cost of goods sold, and net profit require source tables or transaction linkage that this app does not have. No empty or fabricated reports are presented under those names. Replenishment does not account for outstanding purchase orders or supplier lead time.

## Validation

`scripts/test-accounting.mjs` checks inventory-cycle semantics. `scripts/test-inventory-insights.mjs` verifies coverage, transfer exclusion, ABC, dormancy, branch/daily reconciliation, expiry and material filters. `scripts/check-accounting-ui.mjs` verifies 21 views/export sheets, filters, real Excel write/read, print, dashboard drill-down, mobile rendering and failure handling. SQL/JavaScript accounting checks compare authoritative RPC results with client calculations.

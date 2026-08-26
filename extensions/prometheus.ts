/**
 * Compatibility shim for the two consumers of the pre-split path that this
 * change does not own: scripts/poster.mjs and the tarball assertion in
 * .github/workflows/ci.yml. The extension itself now lives in
 * extensions/prometheus/, and package.json pins the manifest straight at
 * extensions/prometheus/index.ts.
 *
 * Deliberately no default export. Pi's discovery loads every direct *.ts under
 * a configured directory as a standalone extension (loader.js:589), so if the
 * manifest is ever widened back to ["./extensions"], this file fails loudly
 * with "does not export a valid factory function" instead of quietly
 * registering the exporter a second time — two HTTP servers, duplicate
 * commands, doubled counters.
 */
export { buildBudgetReport } from "./prometheus/report.ts";

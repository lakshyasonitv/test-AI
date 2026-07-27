/**
 * Standalone script to test the Deterministic Crawler against a real multi-page site.
 * Run with: npx tsx src/scripts/test-crawler.ts
 *
 * Usage:
 *   npx tsx src/scripts/test-crawler.ts                           # default: the-internet.herokuapp.com, maxPages=10
 *   npx tsx src/scripts/test-crawler.ts --maxPages=1              # test truncation
 *   npx tsx src/scripts/test-crawler.ts --url=https://example.com  # custom URL
 */
import { buildCrawlDirective } from "../stages/crawlDirective.js";
import { crawlSite } from "../stages/crawler.js";

function parseArgs(): { url: string; maxPages: number; maxDepth: number } {
  const args = process.argv.slice(2);
  let url = "https://the-internet.herokuapp.com";
  let maxPages = 10;
  let maxDepth = 2;

  for (const arg of args) {
    if (arg.startsWith("--url=")) url = arg.split("=")[1];
    if (arg.startsWith("--maxPages=")) maxPages = Number(arg.split("=")[1]);
    if (arg.startsWith("--maxDepth=")) maxDepth = Number(arg.split("=")[1]);
  }

  return { url, maxPages, maxDepth };
}

async function main() {
  const { url, maxPages, maxDepth } = parseArgs();

  console.log(`\nCrawling: ${url}`);
  console.log(`Limits: maxPages=${maxPages}, maxDepth=${maxDepth}\n`);

  // Build a CrawlDirective manually (no Plan needed for standalone test).
  const directive = buildCrawlDirective(
    { goal: "test", steps: ["navigate"], testTypeScope: ["functional"], coverage: "standard" },
    url
  );
  // Override scope defaults with CLI args.
  directive.scope.maxPages = maxPages;
  directive.scope.maxDepth = maxDepth;

  const graph = await crawlSite(directive);

  console.log("=== SiteGraph ===");
  console.log(`Entry URL:  ${graph.entryUrl}`);
  console.log(`Pages found: ${Object.keys(graph.pages).length}`);
  console.log(`Truncated:  ${graph.truncatedByScope}\n`);

  for (const [pageUrl, page] of Object.entries(graph.pages)) {
    const concepts = page.appModel?.pages.flatMap((p) => p.concepts) ?? [];
    const elements = page.appModel?.pages.flatMap((p) => p.elements) ?? [];
    console.log(`  ${pageUrl}`);
    console.log(`    concepts: ${concepts.length ? concepts.join(", ") : "(none)"}`);
    console.log(`    elements: ${elements.length}`);
    console.log(`    outbound: ${page.outboundTargets.length} links`);
    if (page.outboundTargets.length > 0) {
      for (const t of page.outboundTargets.slice(0, 5)) {
        console.log(`      -> ${t}`);
      }
      if (page.outboundTargets.length > 5) {
        console.log(`      ... and ${page.outboundTargets.length - 5} more`);
      }
    }
    console.log();
  }

  // Test maxPages=1 truncation.
  if (maxPages > 1) {
    console.log("\n--- Re-running with maxPages=1 to test truncation ---\n");
    directive.scope.maxPages = 1;
    const truncated = await crawlSite(directive);
    const pageCount = Object.keys(truncated.pages).length;
    console.log(`Pages found: ${pageCount}`);
    console.log(`Truncated:   ${truncated.truncatedByScope}`);
    console.log(pageCount === 1 && truncated.truncatedByScope
      ? "\n[PASS] maxPages=1 produces exactly 1 page and truncatedByScope=true"
      : "\n[FAIL] maxPages=1 did not produce expected result");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// Render many stills with one bundle and one browser.
//   node render-stills.mjs jobs.json
// jobs.json: [{ "composition": "Card", "props": {...}, "output": "abs/path.png", "imageFormat": "png"|"jpeg", "jpegQuality": 90 }]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";

const here = path.dirname(fileURLToPath(import.meta.url));
const jobsFile = process.argv[2];
if (!jobsFile) {
  console.error("usage: node render-stills.mjs jobs.json");
  process.exit(2);
}
const jobs = JSON.parse(readFileSync(jobsFile, "utf8"));

const serveUrl = await bundle({ entryPoint: path.join(here, "src", "index.ts"), onProgress: () => undefined });
const browser = await openBrowser("chrome", { chromiumOptions: { gl: "angle" } });
let failed = 0;
try {
  for (const job of jobs) {
    try {
      const composition = await selectComposition({ serveUrl, id: job.composition, inputProps: job.props, puppeteerInstance: browser });
      await renderStill({
        composition,
        serveUrl,
        output: job.output,
        inputProps: job.props,
        imageFormat: job.imageFormat ?? "png",
        jpegQuality: job.imageFormat === "jpeg" ? (job.jpegQuality ?? 90) : undefined,
        puppeteerInstance: browser,
        overwrite: true,
      });
      console.log(JSON.stringify({ ok: true, output: job.output }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ ok: false, output: job.output, error: String(error?.message ?? error) }));
    }
  }
} finally {
  await browser.close({ silent: true });
}
process.exit(failed ? 1 : 0);

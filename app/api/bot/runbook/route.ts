import { readFile } from "node:fs/promises";
import path from "node:path";
import { baseUrl } from "@/lib/http";

export async function GET(request: Request) {
  const text = await readFile(path.join(process.cwd(), "bot", "RUNBOOK.md"), "utf8");
  return new Response(text.replaceAll("{{BASE_URL}}", baseUrl(request)), {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
  });
}

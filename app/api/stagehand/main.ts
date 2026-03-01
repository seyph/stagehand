import type { Stagehand } from "@browserbasehq/stagehand";
import { put } from "@vercel/blob";
import puppeteer from "puppeteer-core";
import { ksuid } from "@/utils/ksuid";
import {
  buildMultiPagePdf,
  capturePageInput,
  type PageInput,
  type RGB,
  SelectorNotFoundError,
} from "@/utils/pdf";
import type { PdfBody } from "@/utils/pdfSchema";

function hexToRgb(hex: string): RGB {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** Picks the most frequently occurring color among all pages (with 32-step quantization). */
function findMostFrequentColor(colors: RGB[]): RGB {
  if (colors.length === 0) return { r: 128, g: 128, b: 128 };
  if (colors.length === 1) return colors[0];
  const bucket = (v: number) => Math.round(v / 32) * 32;
  const counts = new Map<string, { color: RGB; count: number }>();
  for (const c of colors) {
    const key = `${bucket(c.r)},${bucket(c.g)},${bucket(c.b)}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { color: c, count: 1 });
  }
  let best = colors[0];
  let bestCount = 0;
  for (const { color, count } of counts.values()) {
    if (count > bestCount) { bestCount = count; best = color; }
  }
  return best;
}

export async function main({
  stagehand,
  body,
}: {
  stagehand: Stagehand;
  body: PdfBody;
}): Promise<{ pdfUrl: string }> {
  const id = ksuid.generate();

  const MAX_ATTEMPTS = 3;
  const pageInputs: PageInput[] = [];

  const browser = await puppeteer.connect({
    browserWSEndpoint: stagehand.connectURL(),
    defaultViewport: null,
  });

  try {
    for (const item of body.items) {
      const options = {
        selector: (item.selectors?.main ?? body.selectors?.main)!,
        wait: item.selectors?.wait ?? body.selectors?.wait ?? [],
        remove: item.selectors?.remove ?? body.selectors?.remove ?? [],
        margin: item.document?.margin ?? body.document?.margin,
        padding: item.document?.padding ?? body.document?.padding,
        acceptLanguage: body.acceptLanguage,
      };

      let lastError: unknown;
      let captured = false;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          pageInputs.push(await capturePageInput(browser, item.url, options));
          captured = true;
          break;
        } catch (err) {
          if (err instanceof SelectorNotFoundError) {
            throw err;
          }
          lastError = err;
        }
      }

      if (!captured) {
        const message =
          lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(
          `Failed to capture ${item.url} after ${MAX_ATTEMPTS} attempts: ${message}`,
        );
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Resolve margin colors based on color mode at document and item level.
  const docColor = body.document?.color;
  const needsGlobal =
    docColor === "global" ||
    body.items.some((item) => item.document?.color === "global");
  const globalColor = needsGlobal
    ? findMostFrequentColor(pageInputs.map((p) => p.dominantColor))
    : undefined;

  for (let idx = 0; idx < pageInputs.length; idx++) {
    const itemColor = body.items[idx].document?.color;
    const effective = itemColor ?? docColor;
    if (!effective || effective === "auto") continue;
    pageInputs[idx] = {
      ...pageInputs[idx],
      color:
        effective === "global"
          ? (globalColor ?? pageInputs[idx].dominantColor)
          : hexToRgb(effective),
    };
  }

  const pdfBytes = await buildMultiPagePdf(pageInputs);

  const { url: pdfUrl } = await put(
    `pdfs/${id}.pdf`,
    pdfBytes.buffer as ArrayBuffer,
    { access: "public", contentType: "application/pdf" },
  );

  console.log(pdfUrl);

  return { pdfUrl };
}

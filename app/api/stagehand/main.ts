import type { Stagehand } from "@browserbasehq/stagehand";
import { put } from "@vercel/blob";
import puppeteer from "puppeteer-core";
import { ksuid } from "@/utils/ksuid";
import {
  buildMultiPagePdf,
  capturePageInput,
  type PageInput,
  SelectorNotFoundError,
} from "@/utils/pdf";
import type { PdfBody } from "@/utils/pdfSchema";

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

  const pdfBytes = await buildMultiPagePdf(pageInputs);

  const { url: pdfUrl } = await put(
    `pdfs/${id}.pdf`,
    pdfBytes.buffer as ArrayBuffer,
    { access: "public", contentType: "application/pdf" },
  );

  console.log(pdfUrl);

  return { pdfUrl };
}

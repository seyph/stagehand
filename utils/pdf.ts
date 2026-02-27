import {
  PDFArray,
  PDFDocument,
  type PDFEmbeddedPage,
  type PDFFont,
  PDFName,
  PDFNumber,
  type PDFPage,
  PDFString,
  rgb,
  StandardFonts,
} from "pdf-lib";
import type { Browser, Page } from "puppeteer-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A plain RGB color with channels in the 0–255 range. */
export type RGB = { r: number; g: number; b: number };

/**
 * Bounding box and metadata of the target DOM element, measured in CSS pixels
 * and including the scroll-adjusted absolute position within the full document.
 */
export type ElementRect = {
  /** Absolute left edge (px, scroll-adjusted). */
  left: number;
  /** Absolute top edge (px, scroll-adjusted). */
  top: number;
  /** Absolute right edge (px, scroll-adjusted). */
  right: number;
  /** Absolute bottom edge (px, scroll-adjusted). */
  bottom: number;
  /** Element width in CSS pixels. */
  width: number;
  /** Element height in CSS pixels. */
  height: number;
  /** Full scrollable height of the document in CSS pixels. */
  fullHeight: number;
  /** Full scrollable width of the document in CSS pixels. */
  fullWidth: number;
  /** The first opaque background color found by walking up the element's ancestors. */
  backgroundColor: string;
};

/** Spacing values for margin or padding (in PDF points). */
export type Spacing = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

/**
 * Input data for rendering a single page into an existing PDF document.
 */
export type PageInput = {
  rawPdf: Uint8Array;
  rect: ElementRect;
  dominantColor: RGB;
  url: string;
  margin?: Spacing;
  padding?: Spacing;
};

// ---------------------------------------------------------------------------
// Browser / page setup
// ---------------------------------------------------------------------------

/**
 * Configures a Puppeteer page and navigates it to the target URL.
 *
 * Sets a desktop user-agent and a 1920×1080 viewport, forces `screen` media
 * type to prevent print-only stylesheets from collapsing the layout, then
 * waits for the page to reach network idle.
 *
 * If `options.wait` selectors are provided, each is awaited in order before
 * waiting for the main `options.selector`.
 *
 * @param page - The Puppeteer page instance to configure.
 * @param url - The fully-qualified URL to navigate to.
 * @param options - Selectors to wait for after navigation.
 */
export async function setupPage(
  page: Page,
  url: string,
  options: { selector: string; wait?: string[] },
): Promise<void> {
  // Impersonate a real macOS Chrome to avoid bot-detection on most sites.
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  );

  // Full HD landscape viewport — ensures responsive breakpoints render at
  // desktop widths and avoids mobile-only layouts in the capture.
  await page.setViewport({
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isLandscape: true,
    isMobile: false,
    hasTouch: true,
  });

  // Force screen media so @media print styles don't collapse the desktop layout.
  await page.emulateMediaType("screen");

  // networkidle0 waits until there are zero in-flight network requests for 500 ms,
  // giving fingerprinting scripts and lazy-loaded content time to fully execute
  // before the selector checks begin.
  await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });

  // If wait selectors are provided, wait for each in order — useful when
  // anti-bot or verification screens delay the appearance of real content.
  for (const waitSelector of options.wait ?? []) {
    await page.waitForSelector(waitSelector, { timeout: 60000 });
  }

  await page.waitForSelector(options.selector, { timeout: 60000 });
}

/**
 * Removes all DOM elements matching the given CSS selectors from the page.
 *
 * Invalid selectors are silently ignored so that one bad input doesn't abort
 * the entire capture. Runs as a single `page.evaluate` call to minimize
 * round-trips to the browser process.
 *
 * @param page - The Puppeteer page to operate on.
 * @param selectors - CSS selectors whose matching elements should be removed.
 */
export async function removeElements(
  page: Page,
  selectors: string[],
): Promise<void> {
  if (selectors.length === 0) return;

  await page.evaluate((sels) => {
    for (const sel of sels) {
      try {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          el.remove();
        }
      } catch {
        // Invalid selector — skip silently.
      }
    }
  }, selectors);
}

/**
 * Isolates the target element for capture and returns its bounding rect.
 *
 * Hides all sibling subtrees using `visibility:hidden` (rather than `display:none`)
 * so parent containers stay in flow and `@media` queries continue to see the
 * correct viewport width. Then walks up the ancestor chain to find the nearest
 * explicit background color, which is used to fill the padding area in the PDF.
 * Finally, resets `<html>` and `<body>` backgrounds to transparent so only the
 * pdf-lib margin color shows through.
 *
 * @param page - The Puppeteer page to operate on.
 * @param selector - CSS selector for the element to isolate.
 * @returns The element's bounding rect plus document dimensions, or `null` if
 *   the selector matched nothing.
 */
export async function isolateElement(
  page: Page,
  selector: string,
): Promise<ElementRect | null> {
  return page.evaluate((sel) => {
    const target = document.querySelector(sel) as HTMLElement | null;
    if (!target) return null;

    // Walk up the DOM hiding every sibling along the path to the root.
    // visibility:hidden keeps siblings in flow — parents don't collapse,
    // so @media queries keep seeing the full desktop viewport width.
    let el: HTMLElement | null = target;
    while (el && el !== document.body) {
      const parent: HTMLElement | null = el.parentElement;
      if (parent) {
        for (const child of Array.from(parent.children)) {
          if (child !== el) {
            (child as HTMLElement).style.cssText +=
              ";visibility:hidden!important;";
          }
        }
      }
      el = parent;
    }

    // Walk up the DOM to find the first element with an explicit background color.
    // This color is used to fill the padding area around the content in the PDF.
    let bgColor = "rgb(255, 255, 255)";
    let bgEl: HTMLElement | null = target;
    while (bgEl) {
      const computed = window.getComputedStyle(bgEl).backgroundColor;
      if (
        computed &&
        computed !== "rgba(0, 0, 0, 0)" &&
        computed !== "transparent"
      ) {
        bgColor = computed;
        break;
      }
      bgEl = bgEl.parentElement;
    }

    // Set body/html background to transparent so the padding area is filled
    // with the margin color set by pdf-lib.
    document.documentElement.style.cssText = `margin:0;padding:0;background:transparent;`;
    document.body.style.cssText = `margin:0;padding:0;background:transparent;`;

    const r = target.getBoundingClientRect();

    return {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      right: r.right + window.scrollX,
      bottom: r.bottom + window.scrollY,
      width: r.width,
      height: r.height,
      fullHeight: document.documentElement.scrollHeight,
      fullWidth: document.documentElement.scrollWidth,
      backgroundColor: bgColor,
    };
  }, selector);
}

/**
 * Fixes the darkened-fringe artifact that appears in CSS gradients using
 * `transparent` as a color stop.
 *
 * Chrome represents `transparent` as `rgba(0,0,0,0)` — pure black at alpha 0.
 * When interpolating in premultiplied alpha space, this introduces a dark hue
 * toward the transparent end. The fix rewrites every `background-image` that
 * contains such a stop, replacing `rgba(0,0,0,0)` with the nearest opaque
 * color at alpha 0 (e.g. `rgba(255,100,50,0)`), so Chrome interpolates within
 * the correct hue range.
 *
 * @param page - The Puppeteer page whose gradient styles should be patched.
 */
export async function fixGradientTransparency(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Matches both legacy rgba(0,0,0,0) and modern rgba(0 0 0/0) syntax.
    const TRANSPARENT_RE =
      /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|rgba\(\s*0\s+0\s+0\s*\/\s*0[^)]*\)/g;

    // Captures any rgb/rgba color token, used to collect opaque stops.
    const colorRe =
      /rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*[\d.]+)?\s*\)/g;

    const toRgba0 = (r: string, g: string, b: string) =>
      `rgba(${r}, ${g}, ${b}, 0)`;

    const els = Array.from(document.querySelectorAll("*")) as HTMLElement[];
    for (const el of els) {
      const computed = getComputedStyle(el);
      const bg = computed.backgroundImage;

      // Only process elements with gradients that contain transparent stops.
      if (!bg.includes("gradient") || !TRANSPARENT_RE.test(bg)) continue;
      TRANSPARENT_RE.lastIndex = 0;

      // Collect all non-transparent color stops from the computed gradient.
      const opaqueColors: Array<[string, string, string]> = [];
      colorRe.lastIndex = 0;
      let m = colorRe.exec(bg);
      while (m !== null) {
        const [full, r, g, b] = m;
        if (!TRANSPARENT_RE.test(full)) {
          opaqueColors.push([r, g, b]);
        }
        TRANSPARENT_RE.lastIndex = 0;
        m = colorRe.exec(bg);
      }

      if (opaqueColors.length === 0) continue;

      // Replace every transparent stop with the first opaque color at alpha=0.
      // For gradients with multiple stops, a more accurate approach would pair
      // each transparent stop with its nearest neighbor, but using the first
      // opaque color is sufficient for the common from-transparent pattern.
      const [r, g, b] = opaqueColors[0];
      const fixed = bg.replace(TRANSPARENT_RE, toRgba0(r, g, b));
      el.style.backgroundImage = fixed;
    }
  });
}

// ---------------------------------------------------------------------------
// PDF document assembly
// ---------------------------------------------------------------------------

/** Conversion factor from CSS pixels to PDF points (pt = px × 72/96). */
const PX_TO_PT = 72 / 96;

/**
 * All pre-computed dimensional and typographic values for a single PDF page.
 * Derived once by `computeLayout` and then passed through the drawing functions.
 */
type Layout = {
  /** Total page width in PDF points. */
  pageWidth: number;
  /** Total page height in PDF points. */
  pageHeight: number;
  /** Outer margin on each side (between page edge and padded content area). */
  margin: { top: number; right: number; bottom: number; left: number };
  /** Inner padding on each side (between padded area edge and embedded content). */
  padding: { top: number; right: number; bottom: number; left: number };
  /**
   * Actual bottom margin height in points.
   * Dynamically sized to accommodate the URL text block; never smaller than `margin.bottom`.
   */
  bottomMargin: number;
  /** Embedded content width in PDF points. */
  contentWidth: number;
  /** Embedded content height in PDF points. */
  contentHeight: number;
  /** Width of the rounded background panel (content + padding). */
  paddedWidth: number;
  /** Height of the rounded background panel (content + padding). */
  paddedHeight: number;
  /** X origin for all text in the bottom and top banners. */
  textX: number;
  /** Horizontal padding applied to text inside the margin strips. */
  textPadX: number;
  /** Font size for the "Clique para abrir" label in the bottom block. */
  labelFontSize: number;
  /** Font size for the monospaced URL lines in the bottom block. */
  urlFontSize: number;
  /** Font size for the top banner texts. */
  topBannerFontSize: number;
  /** Line height for a label-sized row (fontSize + lineGap). */
  labelRowH: number;
  /** Line height for a URL-sized row (fontSize + lineGap). */
  urlRowH: number;
  /** Extra vertical gap between the label row and the first URL line. */
  labelToUrlGap: number;
  /** Space from the content bottom edge to the first text element in the bottom block. */
  textBlockPad: number;
  /** Pre-wrapped URL lines that fit within the available text width. */
  urlLines: string[];
};

/**
 * Derives all page dimensions and typographic metrics from the captured element rect.
 *
 * The bottom margin is computed dynamically: it grows to fit however many lines
 * the URL wraps to, but never shrinks below the fixed `margin.bottom` value.
 * Fonts must be provided so that URL wrapping can measure text accurately.
 *
 * @param rect - Bounding box of the captured element (in CSS pixels).
 * @param url - The source URL, used to pre-wrap URL lines for the bottom block.
 * @param fontMono - The embedded monospaced font used for URL line measurement.
 * @param marginOpt - Optional margin override (defaults to 16pt on all sides).
 * @param paddingOpt - Optional padding override (defaults to 20pt on all sides).
 * @returns A fully computed `Layout` object.
 */
function computeLayout(
  rect: ElementRect,
  url: string,
  fontMono: PDFFont,
  marginOpt?: Spacing,
  paddingOpt?: Spacing,
): Layout {
  const contentWidth = rect.width * PX_TO_PT;
  const contentHeight = rect.height * PX_TO_PT;

  // Spacing constants (in PDF points) — caller-provided values take precedence.
  const padding = paddingOpt ?? { top: 20, right: 20, bottom: 20, left: 20 };
  const margin = marginOpt ?? { top: 16, right: 16, bottom: 16, left: 16 };

  const labelFontSize = 9;
  const urlFontSize = 12;
  const lineGap = 2;
  const labelRowH = labelFontSize + lineGap;
  const urlRowH = urlFontSize + lineGap;
  const textBlockPad = 5;
  const labelToUrlGap = 4;
  const topBannerFontSize = 9;
  const textPadX = 10;

  const paddedWidth = contentWidth + padding.left + padding.right;
  const textX = margin.left + textPadX;
  const availableTextWidth = paddedWidth - textPadX * 2;

  // Wrap URL to fit within the padded content width using accurate font metrics.
  const urlLines = wrapText(
    url,
    availableTextWidth,
    (s) => fontMono.widthOfTextAtSize(s, urlFontSize),
    true,
  );

  // The bottom margin must be tall enough to hold all the text in the bottom block.
  const bottomTextHeight =
    textBlockPad + labelRowH + labelToUrlGap + urlLines.length * urlRowH;
  const bottomMargin = Math.max(margin.bottom, bottomTextHeight);

  const paddedHeight = contentHeight + padding.top + padding.bottom;
  const pageWidth = paddedWidth + margin.left + margin.right;
  const pageHeight = paddedHeight + margin.top + bottomMargin;

  return {
    pageWidth,
    pageHeight,
    margin,
    padding,
    bottomMargin,
    contentWidth,
    contentHeight,
    paddedWidth,
    paddedHeight,
    textX,
    textPadX,
    labelFontSize,
    urlFontSize,
    topBannerFontSize,
    labelRowH,
    urlRowH,
    labelToUrlGap,
    textBlockPad,
    urlLines,
  };
}

/**
 * Fills the entire page with the dominant color extracted from the screenshot.
 *
 * This solid rectangle acts as the outer margin background — it bleeds to all
 * edges and is painted first so that every subsequent draw call sits on top of it.
 *
 * @param page - The pdf-lib page to draw on.
 * @param layout - Pre-computed page layout.
 * @param dominantColor - The vibrant color sampled from the element screenshot.
 */
function drawMarginBackground(
  page: PDFPage,
  layout: Layout,
  dominantColor: RGB,
): void {
  page.drawRectangle({
    x: 0,
    y: 0,
    width: layout.pageWidth,
    height: layout.pageHeight,
    color: rgb(
      dominantColor.r / 255,
      dominantColor.g / 255,
      dominantColor.b / 255,
    ),
  });
}

/**
 * Draws the rounded content panel and places the embedded page content inside it.
 *
 * The panel background uses the element's own background color, creating a
 * seamless visual boundary between the margin and the captured content. The
 * embedded page is cropped to the exact element bounds and rendered at the
 * correct position within the padding area.
 *
 * @param page - The pdf-lib page to draw on.
 * @param layout - Pre-computed page layout.
 * @param embeddedPage - The cropped page content to render inside the panel.
 * @param backgroundColor - The CSS background color string for the panel fill.
 */
function drawContentPanel(
  page: PDFPage,
  layout: Layout,
  embeddedPage: PDFEmbeddedPage,
  backgroundColor: string,
): void {
  const borderRadius = 12;

  // Rounded background panel — fills the padding area with the element's own color.
  page.drawSvgPath(
    roundedRectPath(layout.paddedWidth, layout.paddedHeight, borderRadius),
    {
      x: layout.margin.left,
      y: layout.bottomMargin + layout.paddedHeight,
      color: cssRgbToPdfLib(backgroundColor),
    },
  );

  // Render the embedded content inside the padding inset.
  page.drawPage(embeddedPage, {
    x: layout.margin.left + layout.padding.left,
    y: layout.bottomMargin + layout.padding.bottom,
    width: layout.contentWidth,
    height: layout.contentHeight,
  });
}

/**
 * Draws the top margin banner with a left-aligned hint and a right-aligned capture timestamp.
 *
 * Both texts are rendered at reduced opacity to keep them visually secondary
 * while still legible against the margin background color.
 *
 * @param page - The pdf-lib page to draw on.
 * @param layout - Pre-computed page layout.
 * @param fontRegular - The regular-weight font for both texts.
 * @param textColor - White or black, chosen for contrast against the margin color.
 */
function drawTopBanner(
  page: PDFPage,
  layout: Layout,
  fontRegular: PDFFont,
  textColor: ReturnType<typeof rgb>,
): void {
  const topText = "Acesse o link ao final desta página";

  // Build a localized capture timestamp in the São Paulo timezone.
  const captureDate = new Date();
  const captureParts = new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).formatToParts(captureDate);
  const getPart = (type: string) =>
    captureParts.find((p) => p.type === type)?.value ?? "";
  const captureText = `Captura realizada em ${getPart("day")} de ${getPart("month")} de ${getPart("year")} às ${getPart("hour")}:${getPart("minute")}:${getPart("second")}`;

  // Right-align the timestamp by measuring its width and subtracting from the right edge.
  const captureDateW = fontRegular.widthOfTextAtSize(
    captureText,
    layout.topBannerFontSize,
  );
  const topBannerY =
    layout.bottomMargin +
    layout.paddedHeight +
    (layout.margin.top - layout.topBannerFontSize) / 2 +
    1.5;
  const rightTextX =
    layout.pageWidth - layout.margin.right - layout.textPadX - captureDateW;

  page.drawText(topText, {
    x: layout.textX,
    y: topBannerY,
    size: layout.topBannerFontSize,
    font: fontRegular,
    color: textColor,
    opacity: 0.55,
  });

  page.drawText(captureText, {
    x: rightTextX,
    y: topBannerY,
    size: layout.topBannerFontSize,
    font: fontRegular,
    color: textColor,
    opacity: 0.55,
  });
}

/**
 * Draws the bottom text block: a label with an external-link icon followed by
 * the wrapped URL lines.
 *
 * All elements live within the bottom margin strip (y: 0 → bottomMargin).
 * A cursor starts at the top of the strip and advances downward as each
 * element is placed.
 *
 * @param page - The pdf-lib page to draw on.
 * @param layout - Pre-computed page layout (includes pre-wrapped URL lines).
 * @param fontMono - The monospaced font for the URL text.
 * @param fontRegular - The regular font for the label text.
 * @param textColor - White or black, chosen for contrast against the margin color.
 */
function drawBottomBlock(
  page: PDFPage,
  layout: Layout,
  fontMono: PDFFont,
  fontRegular: PDFFont,
  textColor: ReturnType<typeof rgb>,
): void {
  // Start cursor at the top of the bottom strip, inset by textBlockPad.
  let cursorY =
    layout.bottomMargin - layout.textBlockPad - layout.labelFontSize;

  // Label text at reduced opacity to keep it visually secondary.
  const labelText = "Clique para abrir em nova aba";
  page.drawText(labelText, {
    x: layout.textX,
    y: cursorY,
    size: layout.labelFontSize,
    font: fontRegular,
    color: textColor,
    opacity: 0.55,
  });

  // External-link icon placed immediately after the label text.
  const iconSize = layout.labelFontSize - 1;
  const iconGap = 4;
  const labelW = fontRegular.widthOfTextAtSize(labelText, layout.labelFontSize);
  drawExternalLinkIcon(
    page,
    layout.textX + labelW + iconGap,
    cursorY - 1.5,
    iconSize,
    textColor,
    0.55,
  );

  cursorY -= layout.labelRowH + layout.labelToUrlGap;

  // Render each wrapped URL line at full opacity using the monospaced font.
  for (const line of layout.urlLines) {
    page.drawText(line, {
      x: layout.textX,
      y: cursorY,
      size: layout.urlFontSize,
      font: fontMono,
      color: textColor,
    });
    cursorY -= layout.urlRowH;
  }
}

/**
 * Adds an invisible link annotation covering the entire bottom text block.
 *
 * The annotation bounds are computed to tightly wrap both the label+icon row
 * and all URL lines, using the widest of the two as the annotation width.
 * Uses a JavaScript `app.launchURL` action for maximum PDF viewer compatibility.
 *
 * @param pdfDoc - The pdf-lib document to register the annotation in.
 * @param page - The pdf-lib page to attach the annotation to.
 * @param layout - Pre-computed page layout.
 * @param url - The target URL for the link.
 * @param fontMono - The monospaced font for measuring URL line widths.
 * @param fontRegular - The regular font for measuring the label width.
 */
function addBottomLinkAnnotation(
  pdfDoc: PDFDocument,
  page: PDFPage,
  layout: Layout,
  url: string,
  fontMono: PDFFont,
  fontRegular: PDFFont,
): void {
  const labelText = "Clique para abrir em nova aba";
  const iconSize = layout.labelFontSize - 1;
  const iconGap = 4;
  const labelW = fontRegular.widthOfTextAtSize(labelText, layout.labelFontSize);

  // Annotation top = just below the content panel; bottom = below the last URL line.
  const annotTop = layout.bottomMargin - layout.textBlockPad;
  const annotBottom =
    layout.bottomMargin -
    layout.textBlockPad -
    layout.labelRowH -
    layout.labelToUrlGap -
    layout.urlLines.length * layout.urlRowH;

  // Width covers whichever is wider: the label+icon or the longest URL line.
  const annotW = Math.max(
    labelW + iconGap + iconSize,
    ...layout.urlLines.map((l) =>
      fontMono.widthOfTextAtSize(l, layout.urlFontSize),
    ),
  );

  addLinkAnnotation(pdfDoc, page, url, {
    x: layout.textX,
    y: annotBottom,
    w: annotW,
    h: annotTop - annotBottom,
  });
}

/**
 * Adds a single styled page to an existing PDF document from a raw Puppeteer-rendered PDF.
 *
 * Embeds the cropped element content surrounded by a colored margin, a rounded
 * content panel, a top banner with the capture timestamp, and a bottom block
 * with the source URL and a clickable link annotation.
 *
 * @param pdfDoc - The pdf-lib document to add the page to.
 * @param fontRegular - Pre-embedded regular font (for reuse across pages).
 * @param fontMono - Pre-embedded monospaced font (for reuse across pages).
 * @param input - Page input data (rawPdf, rect, dominantColor, url, margin, padding).
 */
async function buildPdfPage(
  pdfDoc: PDFDocument,
  fontRegular: PDFFont,
  fontMono: PDFFont,
  input: PageInput,
): Promise<void> {
  const { rawPdf, rect, dominantColor, url, margin, padding } = input;

  const layout = computeLayout(rect, url, fontMono, margin, padding);

  // Load the raw PDF and crop the source page to the captured element bounds.
  const sourcePdf = await PDFDocument.load(rawPdf);
  const [sourcePage] = sourcePdf.getPages();
  const embeddedPage = await pdfDoc.embedPage(sourcePage, {
    left: rect.left * PX_TO_PT,
    right: rect.right * PX_TO_PT,
    // pdf-lib Y axis grows upward; convert from top-down CSS coords.
    bottom: (rect.fullHeight - rect.bottom) * PX_TO_PT,
    top: (rect.fullHeight - rect.top) * PX_TO_PT,
  });

  const page = pdfDoc.addPage([layout.pageWidth, layout.pageHeight]);

  // Choose text color (black or white) for maximum contrast on the margin color.
  const textColor = contrastColor(dominantColor);

  // Layer drawing order: background → panel → content → banners → annotation.
  drawMarginBackground(page, layout, dominantColor);
  drawContentPanel(page, layout, embeddedPage, rect.backgroundColor);
  drawTopBanner(page, layout, fontRegular, textColor);
  drawBottomBlock(page, layout, fontMono, fontRegular, textColor);
  addBottomLinkAnnotation(pdfDoc, page, layout, url, fontMono, fontRegular);
}

/**
 * Assembles a multi-page PDF document from one or more captured page inputs.
 *
 * Fonts are embedded once and reused for all pages. Each `PageInput` becomes
 * one page in the final document, in order.
 *
 * @param pages - Array of captured page data to render, in order.
 * @returns The serialized PDF bytes ready to be sent as the HTTP response body.
 */
export async function buildMultiPagePdf(
  pages: PageInput[],
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();

  // Embed fonts once — shared across all pages for consistent metrics.
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

  for (const input of pages) {
    await buildPdfPage(pdfDoc, fontRegular, fontMono, input);
  }

  return pdfDoc.save();
}

/**
 * Derives a safe PDF filename from the given URL.
 *
 * Combines hostname and pathname, then replaces every non-alphanumeric
 * character with an underscore, collapses consecutive underscores, and
 * strips leading/trailing underscores.
 *
 * @example
 * buildFileName("https://example.com/foo/bar?x=1") // "example_com_foo_bar.pdf"
 *
 * @param url - The source URL to derive the filename from.
 * @returns A filesystem-safe filename ending in `.pdf`.
 */
export function buildFileName(url: string): string {
  const { hostname, pathname } = new URL(url);
  return (
    (hostname + pathname)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "") + ".pdf"
  );
}

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

/**
 * Thrown by `capturePageInput` when the target CSS selector yields no element.
 * Distinguishes a "not found" condition from transient browser errors so the
 * caller can return an appropriate HTTP 404 without retrying.
 */
export class SelectorNotFoundError extends Error {
  constructor(selector: string, url: string) {
    super(`Selector "${selector}" not found on ${url}`);
    this.name = "SelectorNotFoundError";
  }
}

export type CaptureOptions = {
  selector: string;
  wait: string[];
  remove: string[];
  margin?: Spacing;
  padding?: Spacing;
};

/**
 * Opens a new tab in `browser`, navigates to `url`, captures the target
 * element, and returns the assembled `PageInput`.
 *
 * The tab is always closed before returning, keeping memory usage bounded and
 * ensuring same-domain serialization when items are processed sequentially.
 *
 * @throws {SelectorNotFoundError} if the main selector is absent from the page.
 * @throws any Puppeteer / network error that occurs during capture.
 */
export async function capturePageInput(
  browser: Browser,
  url: string,
  options: CaptureOptions,
): Promise<PageInput> {
  const { selector, wait, remove, margin, padding } = options;
  const [page] = await browser.pages();
  try {
    await setupPage(page, url, { selector, wait });
    await removeElements(page, remove);

    const rect = await isolateElement(page, selector);
    if (!rect) throw new SelectorNotFoundError(selector, url);

    const screenshotBuffer = await page.screenshot({
      clip: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        scale: 0.1,
      },
      type: "png",
    });
    const dominantColor = await vibrantColorFromPng(
      new Uint8Array(screenshotBuffer),
    );

    await fixGradientTransparency(page);

    const rawPdf = await page.pdf({
      width: `${rect.fullWidth}px`,
      height: `${rect.fullHeight}px`,
      printBackground: true,
    });

    return { rawPdf, rect, dominantColor, url, margin, padding };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// PNG color extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the most visually prominent (vibrant) color from a PNG image buffer.
 *
 * Implements a minimal PNG decoder from scratch using the Web Streams
 * `DecompressionStream` API, which is available in Cloudflare Workers without
 * any native dependencies. Only 8-bit RGB and RGBA formats are supported.
 *
 * The algorithm samples every N-th pixel (capped at ~10 000 samples for
 * performance), discards near-transparent, near-grayscale, near-black, and
 * near-white pixels, then runs weighted bucket voting: each quantized color
 * (rounded to the nearest 8 on each channel) accumulates a score of
 * `saturation × log(count + 1)`, and the highest-scoring bucket wins.
 *
 * This color is later used as the PDF margin/background color so that the
 * document feels visually cohesive with the captured element.
 *
 * @param pngBuffer - Raw PNG bytes to decode.
 * @returns The most vibrant color found, or a mid-gray `{128,128,128}` fallback
 *   if no sufficiently colorful pixel exists.
 */
export async function vibrantColorFromPng(pngBuffer: Uint8Array): Promise<RGB> {
  // --- PNG chunk parsing ---
  // PNG structure: 8-byte signature, then a sequence of length+type+data+CRC chunks.
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];

  const view = new DataView(pngBuffer.buffer, pngBuffer.byteOffset);

  while (offset < pngBuffer.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      pngBuffer[offset + 4],
      pngBuffer[offset + 5],
      pngBuffer[offset + 6],
      pngBuffer[offset + 7],
    );
    const data = pngBuffer.slice(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = pngBuffer[offset + 16];
      colorType = pngBuffer[offset + 17];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  // Only support 8-bit RGB (colorType 2) and RGBA (colorType 6).
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    return { r: 0, g: 0, b: 0 };
  }

  const channels = colorType === 6 ? 4 : 3;

  // --- Deflate decompression ---
  // Concatenate all IDAT chunks into a single buffer, then decompress via the
  // Web Streams DecompressionStream (available in CF Workers without wasm/native).
  const compressed = new Uint8Array(
    idatChunks.reduce((sum, c) => sum + c.length, 0),
  );
  let pos = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, pos);
    pos += chunk.length;
  }

  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const decompressed = await new Response(ds.readable).arrayBuffer();
  const raw = new Uint8Array(decompressed);

  // --- PNG filter reconstruction ---
  // Each row is prefixed with a 1-byte filter type (None/Sub/Up/Average/Paeth).
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const filterByte = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[dst + x - channels] : 0; // left
      const b = y > 0 ? pixels[dst - stride + x] : 0; // above
      const c =
        x >= channels && y > 0 ? pixels[dst - stride + x - channels] : 0; // above-left
      const rawByte = raw[src + x];

      let val: number;
      switch (filterByte) {
        case 0:
          val = rawByte;
          break; // None
        case 1:
          val = (rawByte + a) & 0xff;
          break; // Sub
        case 2:
          val = (rawByte + b) & 0xff;
          break; // Up
        case 3:
          val = (rawByte + ((a + b) >> 1)) & 0xff;
          break; // Average
        case 4: {
          // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val =
            (rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default:
          val = rawByte;
      }
      pixels[dst + x] = val;
    }
  }

  // --- Vibrant color sampling ---
  // Sample every Nth pixel for performance, quantize to 8-step buckets, and
  // score each bucket by saturation × log(count+1) to find the most vibrant color.
  const step = Math.max(1, Math.floor((width * height) / 10000));
  const buckets = new Map<
    string,
    { r: number; g: number; b: number; count: number }
  >();

  for (let i = 0; i < width * height; i += step) {
    const base = i * channels;
    const r = pixels[base];
    const g = pixels[base + 1];
    const b = pixels[base + 2];
    const a = channels === 4 ? pixels[base + 3] : 255;

    // Skip near-transparent pixels.
    if (a < 200) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // Skip near-grayscale, near-black, and near-white pixels.
    if (max - min < 30 || max < 40 || max > 240) continue;

    const qr = Math.round(r / 8) * 8;
    const qg = Math.round(g / 8) * 8;
    const qb = Math.round(b / 8) * 8;
    const key = `${qr},${qg},${qb}`;
    const entry = buckets.get(key);
    if (entry) entry.count++;
    else buckets.set(key, { r: qr, g: qg, b: qb, count: 1 });
  }

  if (buckets.size === 0) return { r: 0, g: 0, b: 0 };

  let best: RGB = { r: 128, g: 128, b: 128 };
  let bestScore = -1;

  for (const { r, g, b, count } of buckets.values()) {
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const l = (max + min) / 2;
    const s = (max - min) / (1 - Math.abs(2 * l - 1));
    const score = s * Math.log1p(count);
    if (score > bestScore) {
      bestScore = score;
      best = { r, g, b };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// PDF drawing primitives
// ---------------------------------------------------------------------------

/**
 * Builds a closed rounded-rectangle SVG path string for use with pdf-lib's
 * `drawSvgPath`.
 *
 * The path is expressed in local coordinates with the origin at the
 * **bottom-left** corner and Y increasing upward, matching pdf-lib's coordinate
 * system. Pass the rect's absolute position via `drawSvgPath`'s `x`/`y` options.
 *
 * Corners are approximated with cubic Bézier curves using the standard
 * `k = r × 0.5522848` control-point offset, which gives a visually accurate
 * quarter-circle for any radius.
 *
 * @param w - Rectangle width in points.
 * @param h - Rectangle height in points.
 * @param r - Corner radius in points.
 * @returns An SVG path data string.
 */
export function roundedRectPath(w: number, h: number, r: number): string {
  const k = r * 0.5522848; // cubic Bézier approximation of a quarter-circle

  return [
    `M ${r} 0`,
    `L ${w - r} 0`,
    `C ${w - r + k} 0 ${w} ${r - k} ${w} ${r}`,
    `L ${w} ${h - r}`,
    `C ${w} ${h - r + k} ${w - r + k} ${h} ${w - r} ${h}`,
    `L ${r} ${h}`,
    `C ${r - k} ${h} 0 ${h - r + k} 0 ${h - r}`,
    `L 0 ${r}`,
    `C 0 ${r - k} ${r - k} 0 ${r} 0`,
    `Z`,
  ].join(" ");
}

/**
 * Returns either black or white, whichever achieves a higher contrast ratio
 * against the given background color.
 *
 * Uses the WCAG 2.1 relative luminance formula with sRGB linearization to
 * determine which text color will be more legible on the given background.
 *
 * @param bg - Background color with channels in the 0–255 range.
 * @returns A pdf-lib `rgb(0,0,0)` or `rgb(1,1,1)` color value.
 */
export function contrastColor(bg: RGB): ReturnType<typeof rgb> {
  // Convert sRGB channel values to linear light via the IEC 61966-2-1 piecewise function.
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  // WCAG 2.1 relative luminance: L = 0.2126R + 0.7152G + 0.0722B
  const L =
    0.2126 * toLinear(bg.r) + 0.7152 * toLinear(bg.g) + 0.0722 * toLinear(bg.b);
  // Threshold 0.179 ≈ midpoint between black-on-white and white-on-black contrast.
  return L > 0.179 ? rgb(0, 0, 0) : rgb(1, 1, 1);
}

/**
 * Wraps a string into lines that fit within `maxWidth` using accurate font metrics.
 *
 * In `urlMode`, the algorithm prefers breaking at natural URL separator characters
 * (`/`, `?`, `&`, `#`, `-`, `_`, `.`) and at the end of `%XX` percent-encoded
 * sequences, so the URL remains as readable as possible across line breaks.
 * In plain text mode, it breaks at the last character that still fits.
 *
 * @param text - The string to wrap.
 * @param maxWidth - Maximum line width in points.
 * @param measureFn - A function that returns the rendered width of a string in points.
 * @param urlMode - When `true`, prefer breaking at URL boundary characters.
 * @returns An array of lines, each fitting within `maxWidth`.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measureFn: (s: string) => number,
  urlMode = false,
): string[] {
  const lines: string[] = [];
  let start = 0;

  while (start < text.length) {
    // Advance end until the next character would exceed maxWidth.
    let end = start + 1;
    while (
      end <= text.length &&
      measureFn(text.slice(start, end)) <= maxWidth
    ) {
      end++;
    }
    const lineEnd = end - 1;

    if (lineEnd <= start) {
      // Single character is already too wide — emit it as-is to avoid an infinite loop.
      lines.push(text[start]);
      start++;
    } else if (urlMode) {
      // Try to break at the last natural URL separator at or before lineEnd.
      const segment = text.slice(start, lineEnd);
      // Separators: break after /, ?, &, #, -, _, .
      // For %XX sequences: only break after the last %XX in a consecutive run,
      // never in the middle of an encoded character.
      const breakRe = /[/?&#\-_.]|(?:%[0-9A-Fa-f]{2})+(?=[/?&#\-_.]|$)/g;
      let bestBreak = -1;
      let m = breakRe.exec(segment);
      while (m !== null) {
        bestBreak = m.index + m[0].length;
        m = breakRe.exec(segment);
      }
      if (bestBreak > 0) {
        lines.push(text.slice(start, start + bestBreak));
        start = start + bestBreak;
      } else {
        // No separator found — hard-break at the character boundary.
        lines.push(segment);
        start = lineEnd;
      }
    } else {
      lines.push(text.slice(start, lineEnd));
      start = lineEnd;
    }
  }

  return lines;
}

/**
 * Draws a vector "open in new tab" icon using pdf-lib line primitives.
 *
 * The icon is modeled after a standard external-link glyph: an open rectangle
 * with the top-right corner missing, an arrow-head L-shape in that corner, and
 * a diagonal shaft pointing from the arrow tip toward the rectangle interior.
 *
 * The SVG source viewBox is 12×12. All coordinates are scaled by `size/12` and
 * converted from SVG's top-left origin to pdf-lib's bottom-left origin.
 *
 * @param page - The pdf-lib page to draw on.
 * @param x - Left edge of the icon in PDF points.
 * @param y - Bottom edge of the icon in PDF points (PDF coordinate system).
 * @param size - Desired icon size in PDF points.
 * @param color - Stroke color (typically from `contrastColor`).
 * @param opacity - Stroke opacity (0–1).
 */
export function drawExternalLinkIcon(
  page: PDFPage,
  x: number,
  y: number,
  size: number,
  color: ReturnType<typeof rgb>,
  opacity: number,
): void {
  // SVG viewBox is 12x12. Scale factor maps SVG coords to PDF pts.
  const sc = size / 12;
  const lineOpts = { thickness: sc, color, opacity };

  // pdf-lib drawLine uses PDF coordinates (y grows up), SVG y grows down.
  // Map: pdfX = x + svgX * sc,  pdfY = y + (12 - svgY) * sc
  const px = (svgX: number) => x + svgX * sc;
  const py = (svgY: number) => y + (12 - svgY) * sc;

  // Open rectangle (missing top-right corner).
  page.drawLine({
    start: { x: px(5), y: py(2) },
    end: { x: px(2), y: py(2) },
    ...lineOpts,
  });
  page.drawLine({
    start: { x: px(2), y: py(2) },
    end: { x: px(2), y: py(9) },
    ...lineOpts,
  });
  page.drawLine({
    start: { x: px(2), y: py(9) },
    end: { x: px(9), y: py(9) },
    ...lineOpts,
  });
  page.drawLine({
    start: { x: px(9), y: py(9) },
    end: { x: px(9), y: py(7) },
    ...lineOpts,
  });

  // Arrow head L-shape in the top-right corner.
  page.drawLine({
    start: { x: px(7), y: py(1) },
    end: { x: px(11), y: py(1) },
    ...lineOpts,
  });
  page.drawLine({
    start: { x: px(11), y: py(1) },
    end: { x: px(11), y: py(5) },
    ...lineOpts,
  });

  // Diagonal shaft from arrow tip toward the rectangle interior.
  page.drawLine({
    start: { x: px(11), y: py(1) },
    end: { x: px(5.5), y: py(6.5) },
    ...lineOpts,
  });
}

/**
 * Attaches a clickable link annotation to a rectangular area of a PDF page.
 *
 * Uses a JavaScript `app.launchURL` action rather than a plain URI action for
 * broader PDF viewer compatibility (Acrobat, PDF.js, and most mobile readers).
 * The annotation has an invisible border so it does not visually interfere with
 * the underlying drawn content.
 *
 * @param pdfDoc - The pdf-lib document that owns the annotation context.
 * @param page - The pdf-lib page to attach the annotation to.
 * @param url - The URL to open when the annotation is clicked.
 * @param rect - The clickable area in PDF points: `{ x, y, w, h }`.
 */
export function addLinkAnnotation(
  pdfDoc: PDFDocument,
  page: PDFPage,
  url: string,
  rect: { x: number; y: number; w: number; h: number },
): void {
  const context = pdfDoc.context;

  // Escape backslashes and single quotes for safe embedding in the JS string literal.
  const escapedUrl = url.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const jsAction = context.obj({
    Type: PDFName.of("Action"),
    S: PDFName.of("JavaScript"),
    JS: PDFString.of(`app.launchURL('${escapedUrl}', true);`),
  });
  const jsActionRef = context.register(jsAction);

  const linkAnnotation = context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: [
      PDFNumber.of(rect.x),
      PDFNumber.of(rect.y),
      PDFNumber.of(rect.x + rect.w),
      PDFNumber.of(rect.y + rect.h),
    ],
    // Zero-width border makes the annotation invisible but still clickable.
    Border: [PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(0)],
    A: jsActionRef,
  });

  const annotRef = context.register(linkAnnotation);
  const annots = PDFArray.withContext(context);
  annots.push(annotRef);
  page.node.set(PDFName.of("Annots"), annots);
}

/**
 * Converts a CSS `rgb()` or `rgba()` color string to a pdf-lib `rgb()` color.
 *
 * Channels are normalized from the 0–255 integer range to the 0–1 float range
 * expected by pdf-lib. The alpha component is ignored since pdf-lib handles
 * opacity separately. Returns opaque white as a safe fallback for unparseable input.
 *
 * @param color - A CSS color string such as `"rgb(255, 100, 50)"` or `"rgba(0, 128, 255, 0.5)"`.
 * @returns A pdf-lib `RGB` color value.
 */
export function cssRgbToPdfLib(color: string): ReturnType<typeof rgb> {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);

  // Fallback to white if the string can't be parsed (e.g. named colors, hsl, etc.).
  if (!match) {
    return rgb(1, 1, 1);
  }

  return rgb(
    Number(match[1]) / 255,
    Number(match[2]) / 255,
    Number(match[3]) / 255,
  );
}

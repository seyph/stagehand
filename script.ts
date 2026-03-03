import { Stagehand } from "@browserbasehq/stagehand";
import puppeteer from "puppeteer-core";
import StagehandConfig from "./stagehand.config";
import {
  compressPageImages,
  fixGradientTransparency,
  removeElements,
} from "./utils/pdf";

const stagehand = new Stagehand({
  ...StagehandConfig,
  env: "LOCAL",
  localBrowserLaunchOptions: {
    headless: false, // Show browser window
    // devtools: true, // Open developer tools
    viewport: { width: 1920, height: 1080 },
    // executablePath: "/opt/google/chrome/chrome", // Custom Chrome path
    // port: 9222, // Fixed CDP debugging port
    // args: [
    //   "--no-sandbox",
    //   "--disable-setuid-sandbox",
    //   "--disable-web-security",
    //   "--allow-running-insecure-content",
    // ],
    // userDataDir: "./browser-data", // Persist browser data
    // preserveUserDataDir: true, // Keep data after closing
    // chromiumSandbox: false, // Disable sandbox (adds --no-sandbox)
    // ignoreHTTPSErrors: true, // Ignore certificate errors
    // locale: "en-US", // Set browser language
    // deviceScaleFactor: 1.0, // Display scaling
    // proxy: {
    //   server: "http://proxy.example.com:8080",
    //   username: "user",
    //   password: "pass",
    // },
    // downloadsPath: "./downloads", // Download directory
    // acceptDownloads: true, // Allow downloads
    connectTimeoutMs: 30000, // Connection timeout
  },
});

(async () => {
  const URL = `https://www.reclameaqui.com.br/instituto-superior-de-medicina-ismd/pos-graduacao-em-cosmiatria-curso-caro-comunicacao-ruim-foco-excessivo-em-botox-e-falta-de-organizacao_ooBOTeZ5sWCIXoXp/`;
  const CONTAINER_SELECTOR = `article`;
  const REMOVE: string[] = [
    ".absolute.left-0.top-\\[75px\\]",
    'div[style*="justify-content:center"][style*="padding-top:24px"]',
  ];

  await stagehand.init();

  const browser = await puppeteer.connect({
    browserWSEndpoint: stagehand.connectURL(),
    defaultViewport: null,
  });

  const [page] = await browser.pages();

  await page.emulateMediaType("screen");

  await page.goto(URL, {
    waitUntil: "networkidle0",
    timeout: 0,
  });

  await page.waitForSelector(CONTAINER_SELECTOR, { timeout: 0 });

  await fixGradientTransparency(page);
  await compressPageImages(page, CONTAINER_SELECTOR);
  await removeElements(page, REMOVE);

  // Isolar visualmente o container: sobe toda a árvore ancestral escondendo irmãos
  await page.evaluate((containerSelector) => {
    const KEEP_TAGS = new Set([
      "SCRIPT",
      "STYLE",
      "LINK",
      "META",
      "NOSCRIPT",
      "BASE",
    ]);

    const target = document.querySelector<HTMLElement>(containerSelector);
    if (!target) return;

    let current: Element = target;
    while (current !== document.body && current.parentElement) {
      const parent = current.parentElement;
      for (const child of Array.from(parent.children)) {
        if (child !== current && !KEEP_TAGS.has(child.tagName)) {
          (child as HTMLElement).style.setProperty(
            "display",
            "none",
            "important",
          );
        }
      }
      current = parent;
    }

    // document.body.style.margin = "0";
    // document.body.style.background = "#ffffff";

    // Forçar renderização fiel de cores no PDF sem usar filter (evita rasterização)
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after {
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
    `;
    document.head.appendChild(style);

    // Clonar elementos com box-shadow para preservar sombras com degradê sem perder
    // seleção de texto: remove a sombra do original e insere um clone posicionado
    // absolutamente, com fundo transparente, apenas para renderizar a sombra.
    //
    // Os clones são ancorados no próprio container (não no body) para que as
    // coordenadas sejam relativas a ele — evitando o offset de centralização do
    // container na viewport que varia com a largura da tela.
    if (window.getComputedStyle(target).position === "static") {
      target.style.position = "relative";
    }

    const containerRect = target.getBoundingClientRect();

    const elements = [
      target,
      ...Array.from(target.querySelectorAll<HTMLElement>("*")),
    ];

    for (const el of elements) {
      const computed = window.getComputedStyle(el);
      const boxShadow = computed.boxShadow;
      if (!boxShadow || boxShadow === "none") continue;

      const rect = el.getBoundingClientRect();

      el.style.setProperty("box-shadow", "none", "important");

      const clone = document.createElement("div");
      clone.style.cssText = [
        "position: absolute",
        `top: ${rect.top - containerRect.top}px`,
        `left: ${rect.left - containerRect.left}px`,
        `width: ${rect.width}px`,
        `height: ${rect.height}px`,
        `border-radius: ${computed.borderRadius}`,
        `box-shadow: ${boxShadow}`,
        "background: transparent",
        "pointer-events: none",
        "filter: opacity(1)",
      ].join("; ");

      target.appendChild(clone);
    }
  }, CONTAINER_SELECTOR);

  // Aguardar estabilização real de layout
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const { width, height } = await page.evaluate((containerSelector) => {
    const target = document.querySelector<HTMLElement>(containerSelector);
    if (!target) return { width: 1920, height: 1080 };
    const rect = target.getBoundingClientRect();
    return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  }, CONTAINER_SELECTOR);

  await page.pdf({
    path: `pdfs/file.pdf`,
    printBackground: true,
    outline: true,
    width: `${width}px`,
    height: `${height}px`,
  });

  await stagehand.close();
})();

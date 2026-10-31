import express, { type NextFunction, type Request, type Response } from "express";
import * as cheerio from "cheerio";
import puppeteer, { type Browser } from "puppeteer-core";

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || "";
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? "ethiotelecom.et,safaricom.et")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const MAX_BYTES = 2_000_000;

if (!API_KEY) {
  console.warn("API_KEY not set: the API is open to anyone who knows the URL");
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message);
  }
}

type Pair = { label: string; value: string };

function isAllowed(u: URL): boolean {
  return (
    u.protocol === "https:" &&
    ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))
  );
}

const DEFAULT_WAIT_MS = Number(process.env.WAIT_MS ?? 5000);
const MAX_WAIT_MS = 15_000;
const MAX_PAGES = Number(process.env.MAX_PAGES) || 2;
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

// One shared headless browser, started on first use.
let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const p = puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    browserPromise = p;
    p.then((b) => b.on("disconnected", () => (browserPromise = null))).catch(
      () => (browserPromise = null)
    );
  }
  return browserPromise;
}

// Limit how many pages render at the same time (Chromium is memory hungry).
let active = 0;
const waiters: Array<() => void> = [];
async function acquire() {
  if (active < MAX_PAGES) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

// Opens the link in headless Chromium, waits waitMs for the page's JavaScript
// to finish drawing the receipt, then returns the rendered HTML.
async function fetchPage(link: string, waitMs: number): Promise<string> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new HttpError(400, "Invalid link");
  }
  if (!isAllowed(url)) throw new HttpError(400, "Link host is not allowed");

  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (e) {
    throw new HttpError(500, `Browser failed to start: ${(e as Error).message}`);
  }

  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"
    );
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "font", "media"].includes(req.resourceType())) {
        void req.abort();
        return;
      }
      // Never let the main page navigate (redirect) to a host that isn't allowed.
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        try {
          if (!isAllowed(new URL(req.url()))) {
            void req.abort();
            return;
          }
        } catch {
          void req.abort();
          return;
        }
      }
      void req.continue();
    });

    const res = await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (res && res.status() >= 400) {
      throw new HttpError(502, `Provider returned ${res.status()}`);
    }

    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const html = await page.content();
    if (html.length > MAX_BYTES) throw new HttpError(502, "Page too large");
    return html;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Could not load page: ${(e as Error).message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

// Bilingual labels look like "የላኪ ስም / SENDER NAME": anything ending in "/ ENGLISH CAPS"
const isLabel = (s: string) => /\/\s*[A-Z+][A-Z0-9 +%&.'()\-]*$/.test(s);
const englishPart = (s: string) => clean(s.slice(s.lastIndexOf("/") + 1));

// Walks the page text line by line. Handles "label, value" pairs and
// header rows ("label, label, label, value, value, value").
function pairsFromLines(lines: string[]): Pair[] {
  const out: Pair[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isLabel(lines[i])) {
      i++;
      continue;
    }
    const labels: string[] = [];
    while (i < lines.length && isLabel(lines[i])) labels.push(englishPart(lines[i++]));
    const values: string[] = [];
    while (values.length < labels.length && i < lines.length && !isLabel(lines[i])) {
      values.push(lines[i++]);
    }
    labels.forEach((label, j) => {
      if (values[j] !== undefined) out.push({ label, value: values[j] });
    });
  }
  return out;
}

function extractPairs(html: string): Pair[] {
  const $ = cheerio.load(html);
  $("script,style,noscript").remove();
  const pairs: Pair[] = [];

  const push = (label: string, value: string) => {
    const l = clean(label).replace(/[:：]$/, "").trim();
    const v = clean(value);
    if (l && v && l.length < 60) pairs.push({ label: l, value: v });
  };

  // Table rows: "label | value" (or several label/value couples per row),
  // and header-row / value-row tables.
  $("tr").each((_, tr) => {
    const cells = $(tr)
      .children("td,th")
      .map((_, c) => clean($(c).text()))
      .get();

    const allHeaders = $(tr).children("th").length === cells.length;
    if (cells.length >= 3 && allHeaders) {
      const next = $(tr).next("tr");
      const nextCells = next
        .children("td,th")
        .map((_, c) => clean($(c).text()))
        .get();
      if (nextCells.length === cells.length) {
        cells.forEach((label, j) => push(label, nextCells[j]));
        return;
      }
    }

    if (cells.length >= 2 && cells.length % 2 === 0) {
      for (let i = 0; i < cells.length; i += 2) push(cells[i], cells[i + 1]);
    }
  });

  // Definition lists
  $("dt").each((_, dt) => push($(dt).text(), $(dt).next("dd").text()));

  if (pairs.length < 3) {
    // Layout-agnostic pass: put a line break around every block element,
    // then read the page as lines of text.
    $("br").replaceWith("\n");
    $("div,p,td,th,tr,li,h1,h2,h3,h4,h5,h6,section,label,dt,dd")
      .prepend("\n")
      .append("\n");
    const lines = $("body")
      .text()
      .split("\n")
      .map(clean)
      .filter(Boolean);

    const fromLines = pairsFromLines(lines);
    if (fromLines.length > pairs.length) {
      pairs.length = 0;
      pairs.push(...fromLines);
    }

    // Last resort: "Label: value" lines
    if (pairs.length === 0) {
      lines.forEach((line) => {
        const m = line.match(/^\s*([^:]{2,40}):\s*(.+)$/);
        if (m) push(m[1], m[2]);
      });
    }
  }

  return pairs;
}

// First non-empty value whose label matches, trying each pattern in order.
function pick(pairs: Pair[], ...patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const hit = pairs.find((p) => re.test(p.label) && p.value !== "---");
    if (hit) return hit.value;
  }
  return null;
}

function toNumber(s: string | null): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function detectProvider(link: string): "telebirr" | "mpesa" | "unknown" {
  const host = new URL(link).hostname;
  if (host.endsWith("ethiotelecom.et")) return "telebirr";
  if (host.endsWith("safaricom.et")) return "mpesa";
  return "unknown";
}

async function verify(
  link: string,
  expectedAmount?: number,
  expectedReceiver?: string,
  debug = false,
  waitMs = DEFAULT_WAIT_MS
) {
  let html: string;
  await acquire();
  try {
    html = await fetchPage(link, waitMs);
  } finally {
    release();
  }
  const raw = extractPairs(html);
  if (raw.length === 0) {
    throw new HttpError(
      422,
      "No data found on the page. It may be rendered by JavaScript or the link is invalid.",
      debug ? { length: html.length, htmlPreview: html.slice(0, 3000) } : undefined
    );
  }

  const amountText = pick(raw, /settled\s*amount/i, /total\s*paid/i, /^amount$/i);
  const account = pick(raw, /bank\s*account\s*number/i);
  const accountName =
    account && account.includes(" - ")
      ? account.split(" - ").slice(1).join(" - ").trim()
      : null;

  const fields = {
    transactionId: pick(
      raw,
      /^transaction\s*id$/i,
      /receipt\s*no/i,
      /transaction\s*(id|no)/i,
      /reference/i,
      /invoice\s*no/i
    ),
    receiptNo: pick(raw, /receipt\s*no/i),
    status: pick(raw, /status/i),
    payerName: pick(raw, /^sender\s*name$/i, /payer\s*name/i, /sender/i),
    payerPhone: pick(raw, /sender\s*phone/i),
    receiverName:
      pick(raw, /credited\s*party\s*name/i, /receiver\s*name/i, /beneficiary/i) ??
      accountName,
    receiverBank: pick(raw, /receiver\s*bank/i),
    receiverAccount: account ? account.split(" - ")[0].trim() : null,
    amountText,
    amount: toNumber(amountText),
    serviceFee: toNumber(pick(raw, /service\s*fee/i)),
    total: toNumber(pick(raw, /^total$/i)),
    date: pick(raw, /payment\s*date/i, /date/i),
  };

  const checks: Record<string, boolean> = {};
  if (expectedAmount !== undefined) {
    checks.amountMatches = fields.amount === expectedAmount;
  }
  if (expectedReceiver) {
    checks.receiverMatches =
      !!fields.receiverName &&
      fields.receiverName.toLowerCase().includes(expectedReceiver.toLowerCase());
  }

  return {
    ok: true,
    provider: detectProvider(link),
    fields,
    ...(Object.keys(checks).length ? { checks } : {}),
    raw,
  };
}

const app = express();
app.use(express.json({ limit: "10kb" }));

app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

function auth(req: Request, res: Response, next: NextFunction) {
  if (API_KEY && req.header("x-api-key") !== API_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
}

async function handle(req: Request, res: Response) {
  const src = req.method === "GET" ? req.query : req.body ?? {};
  const link = typeof src.link === "string" ? src.link : "";
  if (!link) {
    res.status(400).json({ ok: false, error: "link is required" });
    return;
  }
  const expectedAmount =
    src.expectedAmount !== undefined && src.expectedAmount !== ""
      ? Number(src.expectedAmount)
      : undefined;
  const expectedReceiver =
    typeof src.expectedReceiver === "string" ? src.expectedReceiver : undefined;
  const debug = src.debug === "1" || src.debug === "true" || src.debug === true;
  const waitRaw = Number(src.waitMs);
  const waitMs =
    src.waitMs !== undefined && src.waitMs !== "" && Number.isFinite(waitRaw)
      ? Math.min(Math.max(waitRaw, 0), MAX_WAIT_MS)
      : DEFAULT_WAIT_MS;

  try {
    res.json(await verify(link, expectedAmount, expectedReceiver, debug, waitMs));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    res.status(status).json({
      ok: false,
      error: (e as Error).message,
      ...(e instanceof HttpError ? e.extra : {}),
    });
  }
}

app.get("/verify", auth, handle);
app.post("/verify", auth, handle);

app.listen(PORT, () => console.log(`Verifier API listening on ${PORT}`));

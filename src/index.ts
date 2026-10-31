import express, { type NextFunction, type Request, type Response } from "express";
import * as cheerio from "cheerio";
import { getDocumentProxy } from "unpdf";

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || "";
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? "ethiotelecom.et,safaricom.et")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const MAX_BYTES = 8_000_000;
const UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

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

// Plain HTTPS fetch that only follows redirects to allowed hosts.
async function fetchText(link: string, accept: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new HttpError(400, "Invalid link");
  }

  for (let i = 0; i < 4; i++) {
    if (!isAllowed(url)) throw new HttpError(400, "Link host is not allowed");

    let res: globalThis.Response;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": UA, accept },
      });
    } catch (e) {
      throw new HttpError(502, `Could not reach provider: ${(e as Error).message}`);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new HttpError(502, "Redirect without location");
      url = new URL(loc, url);
      continue;
    }
    if (!res.ok) throw new HttpError(502, `Provider returned ${res.status}`);

    const text = await res.text();
    if (text.length > MAX_BYTES) throw new HttpError(502, "Response too large");
    return text;
  }
  throw new HttpError(502, "Too many redirects");
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

// Bilingual labels look like "የላኪ ስም / SENDER NAME": anything ending in "/ ENGLISH CAPS"
const isLabel = (s: string) => /\/\s*[A-Z+][A-Z0-9 +%&.'()\-]*$/.test(s);
const englishPart = (s: string) => clean(s.slice(s.lastIndexOf("/") + 1));

/* ------------------------------ M-PESA (PDF) ------------------------------ */

// The M-Pesa receipt page loads its data from /api/receipt/getReceipt?trxNo=<id>,
// which returns JSON with the receipt as a base64 PDF.
async function fetchMpesaPdf(url: URL): Promise<Uint8Array> {
  const m = url.pathname.match(/^\/receipt\/(?:v2\/(Consumer|Merchant)\/)?([^/]+)\/?$/i);
  if (!m) throw new HttpError(400, "Unrecognized M-Pesa receipt link");
  const recipient = m[1];
  const id = decodeURIComponent(m[2]);

  const api = new URL(
    recipient ? "/api/receipt/getReceiptV2" : "/api/receipt/getReceipt",
    url.origin
  );
  api.searchParams.set("trxNo", id);
  if (recipient) api.searchParams.set("RecipientType", recipient);

  const text = await fetchText(api.toString(), "application/json,*/*");
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError(502, "Unexpected response from M-Pesa");
  }
  if (Number(json.responseCode) !== 0) {
    throw new HttpError(404, json.responseDescription || "Receipt not found", {
      responseCode: json.responseCode,
    });
  }
  if (!json.base64Data) throw new HttpError(502, "Receipt has no data");
  return new Uint8Array(Buffer.from(json.base64Data, "base64"));
}

function mergeSlashCells(cells: string[]): string[] {
  const out: string[] = [];
  for (const c of cells) {
    const prev = out[out.length - 1];
    if (prev !== undefined && (c.startsWith("/") || prev.endsWith("/"))) {
      out[out.length - 1] = clean(prev + " " + c);
    } else {
      out.push(c);
    }
  }
  return out;
}

// Rebuilds the PDF's rows and cells from text positions.
async function pdfRows(bytes: Uint8Array): Promise<string[][]> {
  const pdf = await getDocumentProxy(bytes);
  const rows: string[][] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items as any[])
      .filter((i) => typeof i.str === "string" && i.str.trim() !== "")
      .map((i) => ({
        str: i.str as string,
        x: i.transform[4] as number,
        y: i.transform[5] as number,
        w: (i.width as number) || 0,
      }));

    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: (typeof items)[] = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last[0].y - it.y) < 3) last.push(it);
      else lines.push([it]);
    }

    for (const line of lines) {
      line.sort((a, b) => a.x - b.x);
      let cells: string[] = [];
      let cur = "";
      let prevEnd = -Infinity;
      for (const it of line) {
        const gap = it.x - prevEnd;
        if (cur && gap > 10) {
          cells.push(clean(cur));
          cur = "";
        }
        cur += (cur && gap > 1 ? " " : "") + it.str;
        prevEnd = it.x + it.w;
      }
      if (cur) cells.push(clean(cur));
      rows.push(mergeSlashCells(cells));
    }
  }
  return rows;
}

function pairsFromRows(rows: string[][]): Pair[] {
  const out: Pair[] = [];
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r];
    const next = rows[r + 1];

    // Header row of labels followed by a row of values
    if (cells.length >= 2 && cells.every(isLabel)) {
      if (next && next.length === cells.length && !next.some(isLabel)) {
        cells.forEach((c, j) => out.push({ label: englishPart(c), value: next[j] }));
        r++;
        continue;
      }
    }

    // Label alone on a row, value alone on the next row
    if (cells.length === 1 && isLabel(cells[0]) && next && next.length === 1 && !isLabel(next[0])) {
      out.push({ label: englishPart(cells[0]), value: next[0] });
      r++;
      continue;
    }

    // Label cell followed by value cell on the same row
    for (let i = 0; i < cells.length; i++) {
      if (isLabel(cells[i]) && i + 1 < cells.length && !isLabel(cells[i + 1])) {
        out.push({ label: englishPart(cells[i]), value: cells[i + 1] });
        i++;
      }
    }
  }
  return out;
}

/* ------------------------------ HTML pages ------------------------------- */

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

  $("tr").each((_, tr) => {
    const cells = $(tr)
      .children("td,th")
      .map((_, c) => clean($(c).text()))
      .get();

    const allHeaders = $(tr).children("th").length === cells.length;
    if (cells.length >= 3 && allHeaders) {
      const nextCells = $(tr)
        .next("tr")
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

  $("dt").each((_, dt) => push($(dt).text(), $(dt).next("dd").text()));

  if (pairs.length < 3) {
    $("br").replaceWith("\n");
    $("div,p,td,th,tr,li,h1,h2,h3,h4,h5,h6,section,label,dt,dd").prepend("\n").append("\n");
    const lines = $("body").text().split("\n").map(clean).filter(Boolean);

    const fromLines = pairsFromLines(lines);
    if (fromLines.length > pairs.length) {
      pairs.length = 0;
      pairs.push(...fromLines);
    }
    if (pairs.length === 0) {
      lines.forEach((line) => {
        const m = line.match(/^\s*([^:]{2,40}):\s*(.+)$/);
        if (m) push(m[1], m[2]);
      });
    }
  }
  return pairs;
}

/* -------------------------------- Fields --------------------------------- */

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

function detectProvider(u: URL): "telebirr" | "mpesa" | "unknown" {
  if (u.hostname.endsWith("ethiotelecom.et")) return "telebirr";
  if (u.hostname.endsWith("safaricom.et")) return "mpesa";
  return "unknown";
}

async function verify(
  link: string,
  expectedAmount?: number,
  expectedReceiver?: string,
  debug = false
) {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new HttpError(400, "Invalid link");
  }
  if (!isAllowed(url)) throw new HttpError(400, "Link host is not allowed");

  const provider = detectProvider(url);
  let raw: Pair[];
  let rows: string[][] | undefined;

  if (provider === "mpesa") {
    const bytes = await fetchMpesaPdf(url);
    try {
      rows = await pdfRows(bytes);
    } catch (e) {
      throw new HttpError(502, `Could not read the receipt PDF: ${(e as Error).message}`);
    }
    raw = pairsFromRows(rows);
  } else {
    raw = extractPairs(await fetchText(link, "text/html,application/xhtml+xml,*/*"));
  }

  if (raw.length === 0) {
    throw new HttpError(
      422,
      "No data found in the receipt.",
      debug ? { rows } : undefined
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
    bankTransactionId: pick(raw, /bank\s*transaction\s*id/i),
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
    vat: toNumber(pick(raw, /vat/i)),
    total: toNumber(pick(raw, /^total$/i)),
    amountInWords: pick(raw, /amount\s*in\s*words/i),
    transactionType: pick(raw, /transaction\s*type/i),
    paymentMethod: pick(raw, /payment\s*method/i),
    paymentChannel: pick(raw, /payment\s*channel/i),
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
    provider,
    fields,
    ...(Object.keys(checks).length ? { checks } : {}),
    raw,
    ...(debug && rows ? { rows } : {}),
  };
}

/* --------------------------------- Server -------------------------------- */

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

  try {
    res.json(await verify(link, expectedAmount, expectedReceiver, debug));
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

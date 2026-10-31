import express, { type NextFunction, type Request, type Response } from "express";
import * as cheerio from "cheerio";

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
  constructor(public status: number, message: string) {
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

async function fetchPage(link: string): Promise<string> {
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
        signal: AbortSignal.timeout(15_000),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; receipt-verifier/1.0)",
          accept: "text/html,application/xhtml+xml,*/*",
        },
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
    if (text.length > MAX_BYTES) throw new HttpError(502, "Page too large");
    return text;
  }
  throw new HttpError(502, "Too many redirects");
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

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

  // Fallback: "Label: value" lines in the page text
  if (pairs.length === 0) {
    $("body")
      .text()
      .split(/\n+/)
      .forEach((line) => {
        const m = line.match(/^\s*([^:]{2,40}):\s*(.+)$/);
        if (m) push(m[1], m[2]);
      });
  }

  return pairs;
}

function find(pairs: Pair[], re: RegExp): string | null {
  return pairs.find((p) => re.test(p.label))?.value ?? null;
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

async function verify(link: string, expectedAmount?: number, expectedReceiver?: string) {
  const html = await fetchPage(link);
  const raw = extractPairs(html);
  if (raw.length === 0) {
    throw new HttpError(
      422,
      "No data found on the page. It may be rendered by JavaScript or the link is invalid."
    );
  }

  const amountText = find(raw, /total\s*paid|settled\s*amount|^amount/i);
  const fields = {
    transactionId: find(raw, /receipt\s*no|transaction\s*(id|no)|reference|invoice\s*no/i),
    status: find(raw, /status/i),
    payerName: find(raw, /payer\s*name|sender|^from$/i),
    receiverName: find(raw, /credited\s*party\s*name|receiver|beneficiary|^to$/i),
    amountText,
    amount: toNumber(amountText),
    date: find(raw, /date|time/i),
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

  try {
    res.json(await verify(link, expectedAmount, expectedReceiver));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    res.status(status).json({ ok: false, error: (e as Error).message });
  }
}

app.get("/verify", auth, handle);
app.post("/verify", auth, handle);

app.listen(PORT, () => console.log(`Verifier API listening on ${PORT}`));

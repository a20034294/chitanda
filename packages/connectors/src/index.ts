import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { normalizedSourceRecordSchema, type NormalizedSourceRecord } from "@chitanda/contracts";

export type ConnectorQuery = Record<string, string | number | boolean>;

export type ConnectorCursor = {
  data: Record<string, unknown>;
  etag?: string;
  lastModified?: string;
};

export type CollectRequest = {
  query: ConnectorQuery;
  cursor: ConnectorCursor;
  signal?: AbortSignal;
};

export type CollectResult = {
  records: NormalizedSourceRecord[];
  cursor: ConnectorCursor;
  notModified: boolean;
  rejectedCount: number;
};

export interface SourceConnector {
  readonly id: string;
  readonly mode: "pull" | "push";
  collect(request: CollectRequest): Promise<CollectResult>;
}

export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

type HttpConnectorOptions = {
  fetch?: typeof fetch;
  validateUrl?: (url: URL) => Promise<void>;
  maxResponseBytes?: number;
  timeoutMs?: number;
};

const defaultMaxResponseBytes = 5 * 1024 * 1024;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [first, second] = parts;
  if (parts.length !== 4 || first === undefined || second === undefined) return true;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    first >= 224
  );
}

function isPrivateIp(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

export async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("unsupported_url_scheme", "Only HTTP and HTTPS sources are allowed");
  }
  if (url.username || url.password) {
    throw new ConnectorError(
      "url_credentials_forbidden",
      "Credentials must not be embedded in source URLs"
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new ConnectorError(
      "private_network_forbidden",
      "Private network sources are not allowed"
    );
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
        throw new ConnectorError("dns_lookup_failed", "Source hostname could not be resolved");
      });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new ConnectorError(
      "private_network_forbidden",
      "Private network sources are not allowed"
    );
  }
}

function requiredUrl(query: ConnectorQuery): URL {
  if (typeof query.url !== "string") {
    throw new ConnectorError(
      "invalid_connector_config",
      "Connector query.url must be a URL string"
    );
  }
  try {
    return new URL(query.url);
  } catch {
    throw new ConnectorError("invalid_connector_config", "Connector query.url is invalid");
  }
}

async function readLimitedBody(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new ConnectorError("response_too_large", `Source response exceeds ${limit} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ConnectorError("response_too_large", `Source response exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function fetchDocument(
  request: CollectRequest,
  options: HttpConnectorOptions
): Promise<{
  response: Response;
  body: string | null;
  cursor: ConnectorCursor;
  finalUrl: URL;
}> {
  const initialUrl = requiredUrl(request.query);
  const validateUrl = options.validateUrl ?? assertPublicHttpUrl;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const abort = (): void => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    const headers = new Headers({
      accept:
        "application/json, application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9",
      "user-agent": "Chitanda/0.0 (+self-hosted information monitor)"
    });
    if (request.cursor.etag) headers.set("if-none-match", request.cursor.etag);
    if (request.cursor.lastModified) headers.set("if-modified-since", request.cursor.lastModified);
    let finalUrl = initialUrl;
    let response: Response | undefined;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await validateUrl(finalUrl);
      response = await (options.fetch ?? fetch)(finalUrl, {
        headers,
        redirect: "manual",
        signal: controller.signal
      });
      const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
      const location = response.headers.get("location");
      if (!isRedirect || !location) break;
      if (redirectCount === 5) {
        throw new ConnectorError("too_many_redirects", "Source exceeded five redirects");
      }
      try {
        finalUrl = new URL(location, finalUrl);
      } catch {
        throw new ConnectorError("invalid_redirect", "Source returned an invalid redirect URL");
      }
    }
    if (!response) throw new ConnectorError("source_request_failed", "Source request failed");
    const cursor: ConnectorCursor = { data: request.cursor.data };
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    if (etag) cursor.etag = etag;
    if (lastModified) cursor.lastModified = lastModified;
    if (response.status === 304) return { response, body: null, cursor, finalUrl };
    if (!response.ok) {
      throw new ConnectorError("source_http_error", `Source returned HTTP ${response.status}`);
    }
    return {
      response,
      body: await readLimitedBody(response, options.maxResponseBytes ?? defaultMaxResponseBytes),
      cursor,
      finalUrl
    };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (controller.signal.aborted)
      throw new ConnectorError("source_timeout", "Source request timed out or was cancelled");
    throw new ConnectorError(
      "source_request_failed",
      error instanceof Error ? error.message : "Source request failed"
    );
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abort);
  }
}

function valueText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || null;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return valueText(record["#text"] ?? record._ ?? record.value);
  }
  return null;
}

function valueUrl(value: unknown): string | null {
  const candidate = Array.isArray(value)
    ? value.find((entry) => typeof entry === "object" || typeof entry === "string")
    : value;
  if (candidate && typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    return valueText(record["@href"] ?? record.href ?? record["#text"]);
  }
  return valueText(candidate);
}

function isoDate(value: unknown): string | null {
  const text = valueText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function safeUrl(value: unknown, baseUrl: URL): string | null {
  const text = valueUrl(value);
  if (!text) return null;
  try {
    const url = new URL(text, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export class RssConnector implements SourceConnector {
  readonly id = "rss";
  readonly mode = "pull";
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    textNodeName: "#text"
  });

  constructor(private readonly options: HttpConnectorOptions = {}) {}

  async collect(request: CollectRequest): Promise<CollectResult> {
    const { body, cursor, finalUrl } = await fetchDocument(request, this.options);
    if (body === null) return { records: [], cursor, notModified: true, rejectedCount: 0 };
    const root = this.parser.parse(body) as Record<string, unknown>;
    const rssChannel = (root.rss as Record<string, unknown> | undefined)?.channel as
      Record<string, unknown> | undefined;
    const atomFeed = root.feed as Record<string, unknown> | undefined;
    const entries = rssChannel ? arrayOf(rssChannel.item) : arrayOf(atomFeed?.entry);
    const records: NormalizedSourceRecord[] = [];
    let rejectedCount = 0;
    for (const entryValue of entries) {
      if (!entryValue || typeof entryValue !== "object") {
        rejectedCount += 1;
        continue;
      }
      const entry = entryValue as Record<string, unknown>;
      const canonicalUrl = safeUrl(entry.link, finalUrl);
      const title = valueText(entry.title);
      const candidate = {
        externalId: valueText(entry.guid ?? entry.id) ?? canonicalUrl,
        canonicalUrl,
        title: title ?? canonicalUrl ?? "Untitled feed item",
        content:
          valueText(
            entry["content:encoded"] ?? entry.content ?? entry.description ?? entry.summary
          ) ?? "",
        author: valueText(entry.author ?? entry["dc:creator"]),
        publishedAt: isoDate(entry.pubDate ?? entry.published ?? entry.updated ?? entry.date),
        language: valueText(entry.language ?? rssChannel?.language),
        media: [],
        metadata: {},
        rawPayload: entry
      };
      const parsed = normalizedSourceRecordSchema.safeParse(candidate);
      if (parsed.success) records.push(parsed.data);
      else rejectedCount += 1;
    }
    return { records, cursor, notModified: false, rejectedCount };
  }
}

function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, segment) => {
    if (Array.isArray(current) && /^\d+$/.test(segment)) return current[Number(segment)];
    if (current && typeof current === "object")
      return (current as Record<string, unknown>)[segment];
    return undefined;
  }, value);
}

function queryString(query: ConnectorQuery, key: string, fallback: string): string {
  const value = query[key];
  return typeof value === "string" ? value : fallback;
}

export class JsonApiConnector implements SourceConnector {
  readonly id = "json_api";
  readonly mode = "pull";
  constructor(private readonly options: HttpConnectorOptions = {}) {}

  async collect(request: CollectRequest): Promise<CollectResult> {
    const { body, cursor, finalUrl } = await fetchDocument(request, this.options);
    if (body === null) return { records: [], cursor, notModified: true, rejectedCount: 0 };
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new ConnectorError("invalid_json_response", "Source did not return valid JSON");
    }
    const items = getPath(payload, queryString(request.query, "itemsPath", ""));
    if (!Array.isArray(items)) {
      throw new ConnectorError(
        "invalid_json_shape",
        "Configured itemsPath does not resolve to an array"
      );
    }
    const fields = {
      id: queryString(request.query, "idField", "id"),
      url: queryString(request.query, "urlField", "url"),
      title: queryString(request.query, "titleField", "title"),
      content: queryString(request.query, "contentField", "content"),
      author: queryString(request.query, "authorField", "author"),
      publishedAt: queryString(request.query, "publishedAtField", "publishedAt"),
      language: queryString(request.query, "languageField", "language")
    };
    const records: NormalizedSourceRecord[] = [];
    let rejectedCount = 0;
    for (const item of items) {
      if (!item || typeof item !== "object") {
        rejectedCount += 1;
        continue;
      }
      const canonicalUrl = safeUrl(getPath(item, fields.url), finalUrl);
      const candidate = {
        externalId: valueText(getPath(item, fields.id)) ?? canonicalUrl,
        canonicalUrl,
        title: valueText(getPath(item, fields.title)) ?? canonicalUrl ?? "Untitled JSON item",
        content: valueText(getPath(item, fields.content)) ?? "",
        author: valueText(getPath(item, fields.author)),
        publishedAt: isoDate(getPath(item, fields.publishedAt)),
        language: valueText(getPath(item, fields.language)),
        media: [],
        metadata: {},
        rawPayload: item
      };
      const parsed = normalizedSourceRecordSchema.safeParse(candidate);
      if (parsed.success) records.push(parsed.data);
      else rejectedCount += 1;
    }
    return { records, cursor, notModified: false, rejectedCount };
  }
}

export class ManualConnector implements SourceConnector {
  readonly id = "manual";
  readonly mode = "push";
  async collect(request: CollectRequest): Promise<CollectResult> {
    return { records: [], cursor: request.cursor, notModified: true, rejectedCount: 0 };
  }
}

export class WebhookConnector implements SourceConnector {
  readonly id = "webhook";
  readonly mode = "push";
  async collect(request: CollectRequest): Promise<CollectResult> {
    return { records: [], cursor: request.cursor, notModified: true, rejectedCount: 0 };
  }
}

export function createBuiltinConnectors(): Map<string, SourceConnector> {
  const connectors: SourceConnector[] = [
    new RssConnector(),
    new JsonApiConnector(),
    new ManualConnector(),
    new WebhookConnector()
  ];
  return new Map(connectors.map((connector) => [connector.id, connector]));
}

export function connectorSourceKey(connectorId: string, query: ConnectorQuery): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(query).sort(([a], [b]) => a.localeCompare(b)))
  );
  return createHash("sha256").update(`${connectorId}\0${canonical}`).digest("base64url");
}

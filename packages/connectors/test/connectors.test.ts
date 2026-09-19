import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, JsonApiConnector, RssConnector } from "../src/index.js";

const noCursor = { data: {} };
const allowTestUrl = async (): Promise<void> => undefined;

describe("RSS connector", () => {
  it("normalizes RSS items", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <language>zh-TW</language><item><guid>concert-1</guid><title>測試演唱會</title>
      <link>https://events.example/concert-1</link><description>售票資訊</description>
      <pubDate>Sat, 19 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const connector = new RssConnector({
      validateUrl: allowTestUrl,
      fetch: async () =>
        new Response(xml, { headers: { "content-type": "application/rss+xml", etag: '"v1"' } })
    });
    const result = await connector.collect({
      query: { url: "https://feed.example/rss" },
      cursor: noCursor
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      externalId: "concert-1",
      title: "測試演唱會",
      canonicalUrl: "https://events.example/concert-1",
      language: "zh-TW"
    });
    expect(result.cursor.etag).toBe('"v1"');
  });

  it("returns no records for HTTP 304", async () => {
    let headers: Headers | undefined;
    const connector = new RssConnector({
      validateUrl: allowTestUrl,
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return new Response(null, { status: 304 });
      }
    });
    const result = await connector.collect({
      query: { url: "https://feed.example/rss" },
      cursor: { data: {}, etag: '"v1"' }
    });

    expect(headers?.get("if-none-match")).toBe('"v1"');
    expect(result).toMatchObject({ records: [], notModified: true });
  });
});

describe("JSON API connector", () => {
  it("uses configurable paths and rejects malformed entries without failing the source", async () => {
    const connector = new JsonApiConnector({
      validateUrl: allowTestUrl,
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [{ key: "1", name: "Concert", href: "/events/1", details: "On sale" }, null]
          }),
          { headers: { "content-type": "application/json" } }
        )
    });
    const result = await connector.collect({
      query: {
        url: "https://api.example/events",
        itemsPath: "data",
        idField: "key",
        titleField: "name",
        urlField: "href",
        contentField: "details"
      },
      cursor: noCursor
    });

    expect(result.records[0]).toMatchObject({ externalId: "1", title: "Concert" });
    expect(result.rejectedCount).toBe(1);
  });
});

describe("connector URL policy", () => {
  it("blocks loopback and embedded credentials", async () => {
    await expect(assertPublicHttpUrl(new URL("http://127.0.0.1/feed"))).rejects.toMatchObject({
      code: "private_network_forbidden"
    });
    await expect(
      assertPublicHttpUrl(new URL("https://user:pass@example.com/feed"))
    ).rejects.toMatchObject({
      code: "url_credentials_forbidden"
    });
  });

  it("validates every redirect before following it", async () => {
    const visited: string[] = [];
    const validated: string[] = [];
    const connector = new RssConnector({
      validateUrl: async (url) => {
        validated.push(url.toString());
        if (url.hostname === "127.0.0.1") throw new Error("blocked redirect");
      },
      fetch: async (input) => {
        visited.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" }
        });
      }
    });

    await expect(
      connector.collect({ query: { url: "https://feed.example/rss" }, cursor: noCursor })
    ).rejects.toThrow("blocked redirect");
    expect(visited).toEqual(["https://feed.example/rss"]);
    expect(validated).toEqual(["https://feed.example/rss", "http://127.0.0.1/private"]);
  });
});

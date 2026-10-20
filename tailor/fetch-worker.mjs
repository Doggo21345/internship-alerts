// Child process for fetchAllSync: reads [{url, method, headers, payload,
// contentType}] on stdin, fetches them all at once, prints
// [{code, text}] on stdout.
const input = JSON.parse(await new Response(process.stdin).text());
const out = await Promise.all(input.map(async (r) => {
  try {
    const headers = { ...(r.headers || {}) };
    if (r.contentType) headers["Content-Type"] = r.contentType;
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "user-agent")) headers["User-Agent"] = "internship-alerts resume tailor";
    const res = await fetch(r.url, {
      method: (r.method || "GET").toUpperCase(), headers, body: r.payload,
      redirect: r.followRedirects === false ? "manual" : "follow", signal: AbortSignal.timeout(r.timeoutMs || 240000)
    });
    return { code: res.status, text: await res.text() };
  } catch (e) {
    return { code: 0, text: String(e?.message || e) };
  }
}));
process.stdout.write(JSON.stringify(out));

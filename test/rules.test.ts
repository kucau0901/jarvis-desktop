import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filesInArgs,
  navigation,
  normalizeAddress,
  permissionAllowed,
  sameOrigin,
  shareBody,
  typeOf,
  windowOpening,
} from "../src/rules.ts";

const O = "https://jarvis.example.com";

test("an address becomes an origin", () => {
  assert.deepEqual(normalizeAddress("jarvis.example.com"), { origin: O });
  assert.deepEqual(normalizeAddress("  https://jarvis.example.com/chat?x=1 "), { origin: O });
  assert.deepEqual(normalizeAddress("https://jarvis.example.com:8443"), { origin: "https://jarvis.example.com:8443" });
  assert.deepEqual(normalizeAddress("http://localhost:8787"), { origin: "http://localhost:8787" });
  assert.deepEqual(normalizeAddress("http://127.0.0.1:8787/"), { origin: "http://127.0.0.1:8787" });
  assert.deepEqual(normalizeAddress("http://jarvis.localhost"), { origin: "http://jarvis.localhost" });
  assert.deepEqual(normalizeAddress("127.0.0.1:8790"), { origin: "http://127.0.0.1:8790" });
  assert.deepEqual(normalizeAddress("https://localhost:8443"), { origin: "https://localhost:8443" });
});

test("an address that is not one is refused, saying why", () => {
  for (const bad of ["", "   ", "http://jarvis.example.com", "ftp://jarvis.example.com", "https://me:pw@jarvis.example.com", "https://"]) {
    const r = normalizeAddress(bad);
    assert.ok("error" in r, bad);
  }
  // A host that only looks like this computer is not it.
  assert.ok("error" in normalizeAddress("http://localhost.example.com"));
});

test("same origin is the parsed origin, not the text", () => {
  assert.equal(sameOrigin(`${O}/api/x`, O), true);
  assert.equal(sameOrigin("https://jarvis.example.com.evil.example/", O), false);
  assert.equal(sameOrigin("https://jarvis.example.com:444/", O), false);
  assert.equal(sameOrigin("http://jarvis.example.com/", O), false);
  assert.equal(sameOrigin("not a url", O), false);
});

test("windows the page opens", () => {
  assert.equal(windowOpening(`${O}/api/v1/p/abc`, O), "window");
  assert.equal(windowOpening("about:blank", O), "blank");
  assert.equal(windowOpening("https://accounts.google.com/o/oauth2/auth?x", O), "external");
  assert.equal(windowOpening("http://example.com/", O), "external");
  assert.equal(windowOpening("file:///etc/passwd", O), "deny");
  assert.equal(windowOpening("javascript:alert(1)", O), "deny");
});

test("on Jarvis the window stays on Jarvis; a sign-in in front of it may go where it needs", () => {
  assert.equal(navigation(`${O}/x`, `${O}/`, O), "stay");
  assert.equal(navigation("https://client.example/callback?code=1", `${O}/?connect=1`, O), "external");
  // Cloudflare Access's sign-in, and the provider it sends the person to.
  assert.equal(navigation("https://team.cloudflareaccess.com/cdn-cgi/access/login", "https://team.cloudflareaccess.com/", O), "stay");
  assert.equal(navigation(`${O}/cdn-cgi/access/callback`, "https://team.cloudflareaccess.com/", O), "stay");
  assert.equal(navigation("file:///tmp/x", "https://team.cloudflareaccess.com/", O), "deny");
  // A blank window first goes elsewhere: to the browser.
  assert.equal(navigation("https://news.example/", "about:blank", O), "external");
  assert.equal(navigation("https://news.example/", "", O), "external");
});

test("only Jarvis's own pages get the microphone and the like", () => {
  assert.equal(permissionAllowed("media", `${O}/`, O), true);
  assert.equal(permissionAllowed("notifications", O, O), true);
  assert.equal(permissionAllowed("fullscreen", `${O}/`, O), true);
  assert.equal(permissionAllowed("media", "https://other.example/", O), false);
  assert.equal(permissionAllowed("geolocation", `${O}/`, O), false);
  assert.equal(permissionAllowed("openExternal", `${O}/`, O), false);
});

test("files in a command line", () => {
  const files = new Set(["C:\\a.pdf", "/tmp/b.png"]);
  const isFile = (p: string) => files.has(p);
  assert.deepEqual(filesInArgs(["Jarvis.exe", "C:\\a.pdf", "--hidden", "C:\\missing.txt"], isFile), ["C:\\a.pdf"]);
  // Run from source: the folder after electron is not a file.
  assert.deepEqual(filesInArgs(["electron", ".", "/tmp/b.png"], isFile), ["/tmp/b.png"]);
  assert.deepEqual(filesInArgs(["Jarvis"], isFile), []);
});

test("types by name", () => {
  assert.equal(typeOf("Scan.PDF"), "application/pdf");
  assert.equal(typeOf("photo.jpeg"), "image/jpeg");
  assert.equal(typeOf("notes.md"), "text/markdown");
  assert.equal(typeOf("archive.zip"), "application/octet-stream");
  assert.equal(typeOf("noext"), "application/octet-stream");
});

test("a share is the form a share sheet posts", async () => {
  const body = shareBody(
    [
      { name: "a.txt", type: "text/plain", bytes: new TextEncoder().encode("hello") },
      { name: 'we"ird\r\n.png', type: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    ],
    "B0UND",
  );
  // Read back the way Jarvis's service worker reads it.
  const form = await new Response(body, { headers: { "content-type": "multipart/form-data; boundary=B0UND" } }).formData();
  const files = form.getAll("files") as File[];
  assert.equal(files.length, 2);
  assert.equal(files[0]!.name, "a.txt");
  assert.equal(await files[0]!.text(), "hello");
  assert.equal(files[1]!.name, "we_ird__.png");
  assert.deepEqual([...new Uint8Array(await files[1]!.arrayBuffer())], [1, 2, 3]);
});

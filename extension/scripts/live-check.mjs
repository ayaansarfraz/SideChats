/**
 * The whole chain, for real: a region captured in a browser, sent through the
 * extension's own panel, to the running server, to the Anthropic API.
 *
 * Every other check stops short of the network. `browser-check.mjs` drives real
 * mouse input but never sends anything; the server's tests mock the SDK. So the
 * one thing neither can tell you is whether the bytes the extension produces
 * are the bytes the model ends up looking at — which is exactly the seam that
 * nothing type-checks, since extension/ and server/ declare their image types
 * separately.
 *
 * The fixture puts a shape on the page whose colour appears nowhere in its
 * text, so a reply that names it can only have come from the image.
 *
 * Needs a server on :3000 with a real ANTHROPIC_API_KEY. Costs a token or two.
 * Usage: npm run build && node scripts/live-check.mjs [--headed]
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "dist");

const SHAPE_COLOR = "rgb(20, 160, 90)"; // a green the page never names in words

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Claude</title></head>
<body>
  <main>
    <div class="flex flex-col gap-6">
      <div data-test-render-count="1">
        <div data-testid="user-message"><p>Can you show me the throughput curve?</p></div>
      </div>
      <div data-test-render-count="2">
        <div data-is-streaming="false"><div class="font-claude-response">
          <p>Here is the chart you asked for.</p>
          <div id="shape" style="width:260px;height:260px;background:${SHAPE_COLOR};border-radius:50%"></div>
        </div></div>
      </div>
    </div>
  </main>
</body></html>`;

/** A solid PNG of a given RGB, built here so the colour is known exactly. */
function solidPng(r, g, b, size = 96) {
  const raw = Buffer.concat(
    Array.from({ length: size }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from([r, g, b])))]),
    ),
  );
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const health = await fetch("http://localhost:3000/health").catch(() => null);
if (!health?.ok) {
  console.error("No server on :3000 — run `npm run dev` in server/ first.");
  process.exit(1);
}

const userDataDir = mkdtempSync(join(tmpdir(), "sidechats-live-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: !process.argv.includes("--headed"),
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
});

try {
  const page = await context.newPage();
  await page.route("https://claude.ai/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: PAGE_HTML }),
  );
  await page.goto("https://claude.ai/chat/live");
  await page.waitForTimeout(1500);

  // Start a capture the way the toolbar icon does: worker -> content script.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "START_REGION_CAPTURE" });
    } catch {
      /* the content script answers nothing; a closed port is expected */
    }
  });

  const overlay = page.locator("#sidechats-capture-root");
  await overlay.waitFor({ state: "attached", timeout: 5000 });

  const box = await page.locator("#shape").boundingBox();
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width, box.y + box.height, { steps: 25 });
  await page.mouse.up();
  await page.waitForTimeout(1500);

  const seeded = await page.evaluate(() => {
    const root = document.getElementById("sidechats-root")?.shadowRoot;
    return {
      open: Boolean(root?.querySelector(".sidechats-panel.sidechats-open")),
      thumb: Boolean(root?.querySelector(".sidechats-header-thumb")),
    };
  });
  check("the captured region opens a side chat as its branch point", seeded.open && seeded.thumb,
    JSON.stringify(seeded));
  if (!seeded.open) throw new Error("no panel to type into");

  // Type into the real panel and send. Nothing below is stubbed: this goes
  // through apiClient -> service worker -> localhost:3000 -> Anthropic.
  await page.evaluate(() => {
    const root = document.getElementById("sidechats-root").shadowRoot;
    const input = root.querySelector(".sidechats-input");
    input.focus();
  });
  await page.keyboard.type("Name the single colour filling this image. Reply with just the colour word.");
  await page.keyboard.press("Enter");

  const reply = await page
    .waitForFunction(
      () => {
        const root = document.getElementById("sidechats-root")?.shadowRoot;
        const bubbles = root?.querySelectorAll(".sidechats-bubble--assistant");
        const err = root?.querySelector(".sidechats-bubble--error");
        if (err) return { error: err.textContent };
        return bubbles?.length ? { text: bubbles[bubbles.length - 1].textContent } : null;
      },
      null,
      { timeout: 45000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);

  check("a real reply comes back through the extension, worker and server",
    Boolean(reply && reply.text), reply ? JSON.stringify(reply).slice(0, 200) : "timed out");

  check("the reply describes the captured image, so the model actually received it",
    Boolean(reply?.text && /green/i.test(reply.text)),
    reply?.text ? JSON.stringify(reply.text).slice(0, 160) : "no reply text");

  // A second turn with no new image: the server must re-send the stored one.
  await page.keyboard.type("What shape is it? One word.");
  await page.keyboard.press("Enter");
  const second = await page
    .waitForFunction(
      () => {
        const root = document.getElementById("sidechats-root")?.shadowRoot;
        const bubbles = root?.querySelectorAll(".sidechats-bubble--assistant");
        return bubbles?.length >= 2 ? bubbles[bubbles.length - 1].textContent : null;
      },
      null,
      { timeout: 45000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);

  check("a follow-up with no image still sees the stored screenshot",
    Boolean(second && /circle|circular|round|disc|dot|sphere|ball/i.test(second)),
    second ? JSON.stringify(second).slice(0, 160) : "no second reply");
  // ------------------------------------------------ the other two producers
  //
  // Paste and file-attach share the composer path with capture, but not the
  // decoding path: these arrive as real files rather than as a crop made in
  // the worker, so processImage runs in the page rather than the service
  // worker. Worth proving the bytes survive that route too.

  const purple = solidPng(140, 40, 200).toString("base64");
  await page.evaluate(async (b64) => {
    const root = document.getElementById("sidechats-root").shadowRoot;
    const input = root.querySelector(".sidechats-input");
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "pasted.png", { type: "image/png" }));
    input.focus();
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, purple);
  await page.waitForTimeout(1200);

  const pastedChips = await page.evaluate(
    () =>
      document.getElementById("sidechats-root")?.shadowRoot?.querySelectorAll(".sidechats-chip")
        .length ?? 0,
  );
  check("a pasted image lands in the composer tray", pastedChips === 1, `${pastedChips} chip(s)`);

  await page.keyboard.type("Ignore the earlier picture. Name the colour of the image I just attached, one word.");
  await page.keyboard.press("Enter");
  const pasteReply = await page
    .waitForFunction(
      () => {
        const root = document.getElementById("sidechats-root")?.shadowRoot;
        const b = root?.querySelectorAll(".sidechats-bubble--assistant");
        return b?.length >= 3 ? b[b.length - 1].textContent : null;
      },
      null,
      { timeout: 45000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  check(
    "a pasted image reaches the model",
    Boolean(pasteReply && /purple|violet|magenta/i.test(pasteReply)),
    pasteReply ? JSON.stringify(pasteReply).slice(0, 160) : "no reply",
  );

  // File attach, through the real hidden <input type=file> in the shadow root.
  const orangePath = join(tmpdir(), "sidechats-live-orange.png");
  writeFileSync(orangePath, solidPng(255, 140, 0));
  const fileInput = await page.evaluateHandle(() =>
    document.getElementById("sidechats-root").shadowRoot.querySelector('input[type="file"]'),
  );
  await fileInput.asElement().setInputFiles(orangePath);
  await page.waitForTimeout(1200);

  const attachedChips = await page.evaluate(
    () =>
      document.getElementById("sidechats-root")?.shadowRoot?.querySelectorAll(".sidechats-chip")
        .length ?? 0,
  );
  check("an attached file lands in the composer tray", attachedChips === 1, `${attachedChips} chip(s)`);

  await page.keyboard.type("Name the colour of this newest image, one word.");
  await page.keyboard.press("Enter");
  const fileReply = await page
    .waitForFunction(
      () => {
        const root = document.getElementById("sidechats-root")?.shadowRoot;
        const b = root?.querySelectorAll(".sidechats-bubble--assistant");
        return b?.length >= 4 ? b[b.length - 1].textContent : null;
      },
      null,
      { timeout: 45000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  check(
    "an attached file reaches the model",
    Boolean(fileReply && /orange/i.test(fileReply)),
    fileReply ? JSON.stringify(fileReply).slice(0, 160) : "no reply",
  );
  rmSync(orangePath, { force: true });
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

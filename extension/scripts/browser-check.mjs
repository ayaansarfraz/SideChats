/**
 * Loads the built extension into a real Chromium and drives it against a
 * claude.ai-shaped page.
 *
 * The unit tests exercise extraction in jsdom, which cannot tell us whether the
 * extension actually *loads* on claude.ai: whether the manifest's match
 * patterns admit the host, whether the content script runs, whether a genuine
 * mouse drag produces a selection the adapter understands, and whether the
 * panel mounts with real context in it. That is what this checks.
 *
 * The fixture is served by fulfilling the request for https://claude.ai/ in
 * place, so the page keeps that origin and Chrome applies the same content
 * script matching it would on the live site. It is still fixture markup — this
 * validates the plumbing, not the selectors.
 *
 * The region-capture checks at the end need one thing `dist/` does not have
 * yet: something in the page that calls `initRegionCapture`. That wiring lives
 * in `content.ts`, which belongs to the integration session, so this script
 * builds a *copy* of the built extension with an extra content script — the
 * harness below — that stands in for it. Everything under test is still the
 * real thing: the real `regionCapture.ts`, the real background worker, a real
 * `captureVisibleTab`, and a real mouse drag. `dist/` itself is untouched.
 *
 * Usage: npm run build && node scripts/browser-check.mjs [--headed]
 */
import { chromium } from "playwright";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, "..");
const distDir = resolve(extensionDir, "dist");

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Claude</title></head>
<body>
  <nav aria-label="Sidebar"><p>Recent chats live out here.</p></nav>
  <main>
    <div class="flex flex-col gap-6">
      <div data-test-render-count="1">
        <div data-testid="user-message"><p>What is a perfect matching?</p></div>
      </div>
      <div data-test-render-count="2">
        <div data-is-streaming="false"><div class="font-claude-response">
          <p>A perfect matching pairs up every vertex exactly once.</p>
        </div></div>
      </div>
      <div data-test-render-count="3">
        <div data-testid="user-message"><p>Why does every tree have at most one?</p></div>
      </div>
      <div data-test-render-count="4">
        <div data-is-streaming="false"><div class="font-claude-response">
          <p id="target">Take the symmetric difference of the two matchings.</p>
          <!-- Stands in for a chart: one flat, unmistakable colour, so the
               captured pixels can be checked without a PNG decoder. -->
          <div id="capture-target" style="width:320px;height:140px;background:rgb(0,102,204)"></div>
        </div></div>
        <div data-testid="action-bar"><button type="button">Copy</button></div>
      </div>
    </div>
  </main>
</body></html>`;

/** Aborts the remaining checks without pretending they passed. */
class StopEarly extends Error {}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * A second, instrumented region-capture controller, injected as an extra
 * content script, used for the pixel assertions below.
 *
 * It deliberately does *not* listen for START_REGION_CAPTURE: content.ts wires
 * a real controller to that message now, and two listeners means two overlays
 * mounting under the same id. So this one is driven by a DOM event, and the
 * worker relay is left to the real wiring — which the first check exercises.
 *
 * It talks to the checks through the DOM rather than through globals, because
 * a content script runs in an isolated world and `page.evaluate` runs in the
 * main one — a `window.__lastCapture` set here would be invisible there. Both
 * worlds share the document, so a dataset attribute crosses the boundary.
 *
 * `#sidechats-fake-panel` stands in for Lane B\'s panel: opaque, covering the
 * whole viewport, and driven only by `hideForCapture`/`showAfterCapture`. If
 * that handshake is wrong the screenshot comes back solid red, which is the
 * "the panel photographed itself" bug made visible.
 */
const HARNESS_SRC = `
import { initRegionCapture } from "./src/content/regionCapture";

const fakePanel = document.createElement("div");
fakePanel.id = "sidechats-fake-panel";
fakePanel.style.cssText =
  "position:fixed;inset:0;display:none;background:rgb(220,0,0);z-index:2147483646;";
document.documentElement.appendChild(fakePanel);

// Kept out of the way until the capture checks ask for it, so the earlier
// selection checks run against an unobstructed page.
document.addEventListener("sidechats-check:arm-panel", () => {
  fakePanel.style.display = "block";
});

function report(result) {
  document.documentElement.dataset.sidechatsCapture = JSON.stringify(result);
}

const capture = initRegionCapture(
  (image, context) =>
    report({
      ok: true,
      mediaType: image.mediaType,
      width: image.width,
      height: image.height,
      data: image.data,
      selectedText: context.selectedText,
      parentUserMessage: context.parentUserMessage,
      parentAiResponse: context.parentAiResponse,
      hasScreenshot: Boolean(context.screenshot),
    }),
  {
    hideForCapture: () => {
      fakePanel.style.visibility = "hidden";
    },
    showAfterCapture: () => {
      fakePanel.style.visibility = "";
    },
    onError: (error) => report({ ok: false, error }),
  },
);

document.addEventListener("sidechats-check:start-capture", () => capture.start());
`;

const extDir = mkdtempSync(join(tmpdir(), "sidechats-check-ext-"));
cpSync(distDir, extDir, { recursive: true });
await esbuild.build({
  stdin: { contents: HARNESS_SRC, resolveDir: extensionDir, loader: "ts", sourcefile: "check-harness.ts" },
  bundle: true,
  format: "iife",
  target: "chrome110",
  outfile: join(extDir, "check-harness.js"),
  logLevel: "warning",
});
const checkManifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
checkManifest.content_scripts[0].js.push("check-harness.js");
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(checkManifest, null, 2));

const userDataDir = mkdtempSync(join(tmpdir(), "sidechats-browser-check-"));

const context = await chromium.launchPersistentContext(userDataDir, {
  // `channel: "chromium"` is load-bearing: the default bundled build is the
  // headless shell, which cannot load extensions at all, and every check here
  // would fail for that reason rather than a real one. Pass --headed to watch.
  channel: "chromium",
  headless: !process.argv.includes("--headed"),
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

try {
  const page = await context.newPage();
  const logs = [];
  page.on("console", (msg) => logs.push(msg.text()));

  await page.route("https://claude.ai/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: PAGE_HTML }),
  );
  await page.goto("https://claude.ai/chat/fixture");
  await page.waitForTimeout(1500);

  check(
    "content script runs on claude.ai and picks the Claude adapter",
    logs.some((l) => l.includes("[SideChats]") && l.includes("Claude adapter")),
    logs.filter((l) => l.includes("[SideChats]")).join(" | ") || "no [SideChats] console output",
  );

  // A real mouse drag across the answer, not a synthetic selection event.
  const target = page.locator("#target");
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 20 });
  await page.mouse.up();

  const askButton = page.locator("#sidechats-ask-button");
  await askButton.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const askVisible = await askButton.isVisible();
  check("Ask button appears on a drag-select inside an answer", askVisible);
  // Everything below drives that button, so bail out with a report rather than
  // letting Playwright throw a 30s click timeout over an already-known failure.
  if (!askVisible) throw new StopEarly();

  const bg = await askButton
    .evaluate((el) => getComputedStyle(el).backgroundColor)
    .catch(() => "");
  check(
    "Ask button uses the Claude accent, not ChatGPT green",
    bg === "rgb(217, 119, 87)",
    `computed background ${bg || "unavailable"}`,
  );

  await askButton.click();
  await page.waitForTimeout(500);

  const panelText = await page.evaluate(() => {
    const host = document.getElementById("sidechats-root");
    const preview = host?.shadowRoot?.querySelector(".sidechats-header-preview");
    return preview ? preview.textContent : null;
  });
  check("clicking Ask mounts the panel", panelText !== null);
  check(
    "panel carries the real selected text",
    (panelText ?? "").includes("symmetric difference"),
    JSON.stringify(panelText),
  );

  // Selecting the user's own message must not offer a branch point.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const userMsg = page.locator('[data-testid="user-message"]').last();
  const userBox = await userMsg.boundingBox();
  await page.mouse.move(userBox.x + 5, userBox.y + userBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(userBox.x + userBox.width - 5, userBox.y + userBox.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
  await page.waitForTimeout(500);
  check(
    "no Ask button on a selection in the user's own message",
    !(await page.locator("#sidechats-ask-button").isVisible()),
  );

  // ---------------------------------------------------------------- capture
  //
  // What the pixel checks below actually prove, measured by breaking the code
  // and re-running: deleting `panel.hideForCapture()` turns the capture solid
  // red, and tearing the overlay down after the capture instead of before
  // leaves every pixel dimmed. Both fail loudly. What they do *not* catch is
  // deleting the two `requestAnimationFrame` waits — the round-trip to the
  // worker happens to outlast a paint here, so that one still passes. The
  // waits are insurance against a faster path, not something this check holds
  // in place; treat them as unverified if you are tempted to remove them.

  // The toolbar icon cannot be clicked from Playwright, so the relay is driven
  // from the service worker itself — the same chrome.tabs.sendMessage call
  // chrome.action.onClicked makes, in the same place, over the same channel.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const startCapture = async () => {
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true });
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "START_REGION_CAPTURE" });
      } catch {
        // The harness listener answers nothing; a closed port is expected.
      }
    });
  };

  await page.evaluate(() => window.getSelection().removeAllRanges());
  await startCapture();
  const overlay = page.locator("#sidechats-capture-root");
  await overlay.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
  // Exactly one: content.ts is the only thing wired to the relay. Two would
  // mean a duplicate controller mounting a second overlay under the same id.
  const overlayCount = await overlay.count();
  const overlayMounted = overlayCount === 1;
  check(
    "START_REGION_CAPTURE from the worker mounts the overlay content.ts wired up",
    overlayMounted,
    `overlay count = ${overlayCount}`,
  );
  if (!overlayMounted) throw new StopEarly();

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Escape dismisses the overlay without capturing", (await overlay.count()) === 0);

  // The instrumented controller, for the pixel assertions. Driven directly so
  // it never races the real one over the same relay.
  const startHarnessCapture = async () => {
    await page.evaluate(() =>
      document.dispatchEvent(new CustomEvent("sidechats-check:start-capture")),
    );
  };

  // Arm the stand-in panel, so a capture that fails to hide it comes back red.
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent("sidechats-check:arm-panel")),
  );
  const targetBox = await page.locator("#capture-target").boundingBox();
  await startHarnessCapture();
  await overlay.waitFor({ state: "attached", timeout: 5000 });

  // A genuine mouse drag across the target, corner to corner.
  await page.mouse.move(targetBox.x, targetBox.y);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width, targetBox.y + targetBox.height, {
    steps: 25,
  });
  await page.mouse.up();

  await page
    .waitForFunction(() => document.documentElement.dataset.sidechatsCapture, null, {
      timeout: 10000,
    })
    .catch(() => {});
  const result = JSON.parse(
    (await page.evaluate(() => document.documentElement.dataset.sidechatsCapture ?? "null")) ??
      "null",
  );

  check(
    "a real mouse drag produces a captured image",
    Boolean(result && result.ok),
    result ? JSON.stringify(result.error ?? "").slice(0, 200) : "nothing was reported",
  );
  if (!result || !result.ok) throw new StopEarly();

  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const expected = {
    width: Math.round(targetBox.width * dpr),
    height: Math.round(targetBox.height * dpr),
  };
  check(
    "the crop matches the dragged region at this devicePixelRatio",
    Math.abs(result.width - expected.width) <= 3 && Math.abs(result.height - expected.height) <= 3,
    `got ${result.width}x${result.height}, expected ~${expected.width}x${expected.height} @${dpr}x`,
  );

  // Decoded in the page rather than in Node, which has no PNG decoder here.
  const pixels = await page.evaluate(async ({ data, mediaType }) => {
    const blob = await (await fetch(`data:${mediaType};base64,${data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let target = 0;
    let panel = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
      if (r === 0 && g === 102 && b === 204) target++;
      else if (r > 150 && g < 80 && b < 80) panel++;
    }
    return { total: px.length / 4, target, panel };
  }, result);

  check(
    "the captured pixels are the region itself, undimmed by our own overlay",
    pixels.target / pixels.total > 0.9,
    `${((pixels.target / pixels.total) * 100).toFixed(1)}% exact-match target colour`,
  );
  check(
    "the panel is not inside its own screenshot",
    pixels.panel === 0,
    `${pixels.panel} panel-coloured pixels of ${pixels.total}`,
  );
  check(
    "the capture seeds a context package with the image as the branch point",
    result.hasScreenshot &&
      result.selectedText === "" &&
      result.parentAiResponse.includes("symmetric difference"),
    JSON.stringify({
      selectedText: result.selectedText,
      parentUserMessage: result.parentUserMessage,
      hasScreenshot: result.hasScreenshot,
    }).slice(0, 300),
  );

  // ------------------------------------------------- the real wiring, end to end
  //
  // Everything above drives the instrumented controller, so none of it touches
  // content.ts's decision about where a captured image goes. That decision is
  // the whole of the integration: with no panel on screen a capture seeds a new
  // side chat, and with one open it stages into that conversation instead.

  await page.evaluate(() => {
    const host = document.getElementById("sidechats-root");
    host?.shadowRoot?.querySelector(".sidechats-close")?.click();
    document.getElementById("sidechats-fake-panel")?.remove();
  });
  await page.waitForTimeout(200);

  const dragTarget = async () => {
    const box = await page.locator("#capture-target").boundingBox();
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width, box.y + box.height, { steps: 25 });
    await page.mouse.up();
    await page.waitForTimeout(1200);
  };

  await startCapture();
  await overlay.waitFor({ state: "attached", timeout: 5000 });
  await dragTarget();

  const seeded = await page.evaluate(() => {
    const root = document.getElementById("sidechats-root")?.shadowRoot;
    const panel = root?.querySelector(".sidechats-panel");
    return {
      open: Boolean(panel?.classList.contains("sidechats-open")),
      thumb: root?.querySelector(".sidechats-header-thumb")?.getAttribute("src")?.slice(0, 22) ?? null,
      chips: root?.querySelectorAll(".sidechats-chip").length ?? 0,
    };
  });
  check(
    "a capture with no panel open seeds a side chat with the region as its branch point",
    seeded.open && (seeded.thumb ?? "").startsWith("data:image/") && seeded.chips === 0,
    JSON.stringify(seeded),
  );

  // Same gesture again, but now the panel is up: it must attach to the open
  // conversation rather than replacing it with a fresh one.
  await startCapture();
  await overlay.waitFor({ state: "attached", timeout: 5000 });
  await dragTarget();

  const staged = await page.evaluate(() => {
    const root = document.getElementById("sidechats-root")?.shadowRoot;
    return {
      chips: root?.querySelectorAll(".sidechats-chip").length ?? 0,
      trayHidden: root?.querySelector(".sidechats-tray")?.hidden ?? null,
      thumbStillThere: Boolean(root?.querySelector(".sidechats-header-thumb")),
    };
  });
  check(
    "a capture while the panel is open stages into that conversation instead",
    staged.chips === 1 && staged.trayHidden === false && staged.thumbStillThere,
    JSON.stringify(staged),
  );
} catch (err) {
  if (!(err instanceof StopEarly)) throw err;
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

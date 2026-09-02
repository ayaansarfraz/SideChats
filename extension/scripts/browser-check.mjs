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
 * Usage: npm run build && node scripts/browser-check.mjs [--headed]
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "dist");

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

const userDataDir = mkdtempSync(join(tmpdir(), "sidechats-browser-check-"));

const context = await chromium.launchPersistentContext(userDataDir, {
  // `channel: "chromium"` is load-bearing: the default bundled build is the
  // headless shell, which cannot load extensions at all, and every check here
  // would fail for that reason rather than a real one. Pass --headed to watch.
  channel: "chromium",
  headless: !process.argv.includes("--headed"),
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
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
} catch (err) {
  if (!(err instanceof StopEarly)) throw err;
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

/**
 * Reproduces the "Extension context invalidated." bug end to end, then proves
 * the fix.
 *
 * The bug needs a real extension lifecycle event, which no unit test can fake:
 * the content script must be injected, the page must stay open, and then the
 * extension must actually reload underneath it. That is done here by reaching
 * into the live service worker and calling `chrome.runtime.reload()` — exactly
 * what happens when a developer hits reload on chrome://extensions, or when
 * Chrome pushes an update to a user mid-session.
 *
 * Before the fix the panel rendered Chrome's raw "Extension context
 * invalidated." string in a red bubble, twice, with no way forward. After it,
 * the panel says what happened and offers the one action that works.
 *
 * Usage: npm run build && node scripts/context-invalidation-check.mjs [--headed]
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "dist");

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>ChatGPT</title></head>
<body><main>
  <article data-testid="conversation-turn-1">
    <div data-message-author-role="user"><div>Tell me about Ha Long Bay.</div></div>
  </article>
  <article data-testid="conversation-turn-2">
    <div data-message-author-role="assistant">
      <div class="markdown"><p id="target">Ha Long Bay is a UNESCO site in Vietnam.</p></div>
    </div>
  </article>
</main></body></html>`;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const userDataDir = mkdtempSync(join(tmpdir(), "sidechats-invalidation-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: !process.argv.includes("--headed"),
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
});

/** Read the panel's rendered text out of its shadow root. */
const panelText = (page) =>
  page.evaluate(() => {
    const root = document.getElementById("sidechats-root")?.shadowRoot;
    return root?.querySelector(".sidechats-body")?.textContent ?? null;
  });

try {
  const page = await context.newPage();
  await page.route("https://chatgpt.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: PAGE_HTML }),
  );
  await page.goto("https://chatgpt.com/c/fixture");
  await page.waitForTimeout(1500);

  // Open the panel while the extension is still healthy.
  const target = page.locator("#target");
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 20 });
  await page.mouse.up();
  await page.locator("#sidechats-ask-button").click();
  await page.waitForTimeout(400);
  check("panel opens while the extension is healthy", (await panelText(page)) !== null);

  // Now orphan it, the way a rebuild-and-reload does.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await page.waitForTimeout(2000);

  const stillAlive = await page.evaluate(() => {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  });
  check(
    "reloading the extension really does orphan the content script",
    stillAlive === false,
    stillAlive ? "context still live — the repro did not take" : "chrome.runtime.id is gone",
  );

  // Ask a question into the now-orphaned panel: the screenshot's scenario.
  await page.evaluate(() => {
    const root = document.getElementById("sidechats-root").shadowRoot;
    const input = root.querySelector(".sidechats-input");
    input.value = "what is this place";
    root.querySelector(".sidechats-send").click();
  });
  await page.waitForTimeout(1200);

  const text = (await panelText(page)) ?? "";
  check(
    "the raw Chrome error is no longer shown to the user",
    !text.includes("Extension context invalidated"),
    text.includes("Extension context invalidated") ? "still leaking Chrome's string" : "",
  );
  check(
    "the panel explains what happened and names the remedy",
    /reload the page/i.test(text),
    JSON.stringify(text.slice(0, 120)),
  );

  const hasReload = await page.evaluate(() => {
    const root = document.getElementById("sidechats-root").shadowRoot;
    return Boolean(root.querySelector(".sidechats-reload"));
  });
  check("a reload control is offered", hasReload);

  const inputDisabled = await page.evaluate(() => {
    const root = document.getElementById("sidechats-root").shadowRoot;
    return root.querySelector(".sidechats-input").disabled;
  });
  check("the input is shut off rather than inviting another doomed send", inputDisabled);

  // No recovery check here. `chrome.runtime.reload()` under Playwright's
  // `--load-extension` does not bring the extension back (0 service workers
  // afterwards, no content script on new pages), so a "fresh page works again"
  // assertion would fail for an environment reason and read as a product bug.
  // Real Chrome does restart it; that healthy-extension path is covered by
  // browser-check.mjs.

} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

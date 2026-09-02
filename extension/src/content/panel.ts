import type { ChatMessage, ContextPackage, ImageAttachment, SideChatState } from "../shared/types";
import {
  ImageRejectedError,
  MAX_IMAGES_PER_MESSAGE,
  SUPPORTED_MEDIA_TYPES,
  processImage,
  toDataUrl,
} from "../shared/image";
import { EXTENSION_RELOADED_MESSAGE, isContextInvalidatedError } from "./runtime";
import { renderMarkdown } from "./markdown";

export type PanelDeps = {
  /** Host site's accent, piped through to the panel's own palette. */
  accentColor?: string;
  onSubmit: (
    question: string,
    state: SideChatState,
    images: ImageAttachment[]
  ) => Promise<{ reply: string; sideChatId?: string } | { error: string }>;
};

const DEFAULT_ACCENT = "#5b5bd6";

// Inline so the panel never depends on a network fetch or a font the host
// page's CSP might refuse. `currentColor` lets each button own its colour.
const ICON_CLOSE =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">' +
  '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_SEND =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">' +
  '<path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_ATTACH =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">' +
  '<path d="M12.4 7.3l-4.6 4.6a2.6 2.6 0 0 1-3.7-3.7l5.2-5.2a1.8 1.8 0 0 1 2.5 2.5l-5.1 5.1a0.9 0.9 0 0 1-1.3-1.3l4.4-4.4" ' +
  'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Smaller than ICON_CLOSE and drawn to sit on a dark scrim over a thumbnail.
const ICON_CHIP_REMOVE =
  '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">' +
  '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export type PanelController = {
  open: (ctx: ContextPackage) => void;
  close: () => void;
  /** Stage an image in the composer, from a paste, a file, or a captured region. */
  addImage: (image: ImageAttachment) => void;
  /**
   * Take the panel out of the picture while the tab is being captured — without
   * this it photographs itself. Only covers the panel; the floating Ask button
   * lives in the light DOM and is the caller's to deal with.
   */
  hideForCapture: () => void;
  showAfterCapture: () => void;
  /** Whether the panel is currently on screen. */
  isOpen: () => boolean;
  /**
   * Show a message from outside the panel — a region capture that failed, say.
   * Opens the panel if it isn't already up, because a caller that has no side
   * chat on screen has nowhere else to put it.
   */
  showError: (message: string) => void;
};

const HOST_ID = "sidechats-root";
const PREVIEW_MAX_CHARS = 140;

let cachedCssPromise: Promise<string> | null = null;

// Shadow DOM blocks light-DOM stylesheets from crossing in, so panel.css (also
// referenced from manifest.json for unrelated light-DOM UI) has to be fetched and
// injected into this panel's own shadow root explicitly.
function loadPanelCss(): Promise<string> {
  if (!cachedCssPromise) {
    // `chrome.runtime.getURL` throws synchronously once the extension context
    // is gone, which would otherwise take down ensureMounted() and with it the
    // panel that is supposed to be explaining the problem. An unstyled panel
    // carrying a readable message beats no panel at all.
    cachedCssPromise = (async () => {
      try {
        const res = await fetch(chrome.runtime.getURL("panel.css"));
        return await res.text();
      } catch {
        return "";
      }
    })();
  }
  return cachedCssPromise;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? trimmed.slice(0, max - 1).trimEnd() + "…" : trimmed;
}

function emptyState(ctx: ContextPackage): SideChatState {
  return {
    sideChatId: null,
    contextPackage: ctx,
    messages: [],
    status: "idle",
    error: undefined,
    pendingImages: [],
  };
}

// Host pages often listen globally for "start typing anywhere" (to refocus their
// own composer) or for clicks/keydowns to close their own popovers. Because our
// input lives in a shadow tree, an event.target read from outside the shadow
// boundary is retargeted to the shadow host — a plain <div> — so a host page's
// "skip if the user is already in an input" check silently fails to recognise
// our textarea and steals focus right back the moment the user types. Contained
// here at the shadow host, in the bubble phase, before it can reach any
// document/body-level listener the host page registered.
// `paste` and the drag events are here for a second reason on top of focus:
// the composer consumes an image paste or drop itself, and a host page with its
// own document-level paste/drop handler would otherwise *also* act on it and
// drop the same screenshot into its own composer.
const CONTAINED_EVENTS = [
  "keydown",
  "keyup",
  "keypress",
  "input",
  "mousedown",
  "mouseup",
  "click",
  "paste",
  "dragenter",
  "dragover",
  "dragleave",
  "drop",
] as const;

const FILE_INPUT_ACCEPT = SUPPORTED_MEDIA_TYPES.join(",");

const TOO_MANY_IMAGES_MESSAGE = `You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`;

/** True for a drag carrying files, which is all `dataTransfer` will admit to mid-drag. */
function isFileDrag(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes("Files");
}

export function createPanel(deps: PanelDeps): PanelController {
  let shadowRoot: ShadowRoot | null = null;
  let host: HTMLDivElement;
  let panelEl: HTMLDivElement;
  let headerPreviewEl: HTMLElement;
  let bodyEl: HTMLDivElement;
  let inputEl: HTMLTextAreaElement;
  let sendBtn: HTMLButtonElement;
  let trayEl: HTMLDivElement;
  let fileInputEl: HTMLInputElement;
  let loadingEl: HTMLDivElement | null = null;
  // dragenter/dragleave fire for every child the pointer crosses, so a plain
  // "remove the class on dragleave" flickers the highlight off the moment the
  // drag moves over the textarea. Counting entries against leaves is the usual
  // fix and the only reliable one without hit-testing coordinates.
  let dragDepth = 0;
  // Once the extension context is gone the panel is read-only until reload.
  let contextLost = false;
  let reclaimingFocus = false;
  // The most recent mousedown anywhere in the document, observed (not
  // intercepted) so the reclaim logic below can tell a deliberate click
  // elsewhere on the page apart from a host script yanking focus via a
  // keydown handler with no click behind it at all. Doesn't catch a
  // deliberate keyboard Tab out of the panel — there's no mousedown to
  // observe in that case — but that's a much rarer path into this panel
  // than a click, and reclaiming too eagerly there is the safer failure mode.
  // `host` is unset until ensureMounted() runs (the panel hasn't opened yet),
  // so host?.contains(...) is undefined and every mousedown reads as
  // "outside" until then — correct, since there's nothing to reclaim focus
  // into before the panel exists, not just an accident of the optional chain.
  let lastMousedownWasOutsidePanel = false;
  // createPanel is called once per content-script load (see content.ts), so
  // this listener is meant to live for the page's lifetime and is never
  // removed; revisit if createPanel is ever called more than once.
  document.addEventListener(
    "mousedown",
    (event) => {
      lastMousedownWasOutsidePanel = !(event.target instanceof Node && host?.contains(event.target));
    },
    true,
  );

  let state: SideChatState = emptyState({
    selectedText: "",
    parentUserMessage: "",
    parentAiResponse: "",
  });

  function ensureMounted(): void {
    if (shadowRoot) return;

    host = document.createElement("div");
    host.id = HOST_ID;
    document.body.appendChild(host);
    shadowRoot = host.attachShadow({ mode: "open" });

    for (const type of CONTAINED_EVENTS) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }

    const styleEl = document.createElement("style");
    shadowRoot.appendChild(styleEl);
    loadPanelCss().then((css) => {
      styleEl.textContent = css;
    });

    panelEl = document.createElement("div");
    panelEl.className = "sidechats-panel";
    panelEl.style.setProperty("--sc-accent", deps.accentColor ?? DEFAULT_ACCENT);

    const header = document.createElement("div");
    header.className = "sidechats-header";

    const headerText = document.createElement("div");
    headerText.className = "sidechats-header-text";

    const eyebrow = document.createElement("div");
    eyebrow.className = "sidechats-eyebrow";
    eyebrow.textContent = "Asking about";

    // The excerpt is why this panel exists at all, so it's quoted material and
    // marked up as such rather than being a caption on the close button.
    headerPreviewEl = document.createElement("blockquote");
    headerPreviewEl.className = "sidechats-header-preview";

    headerText.append(eyebrow, headerPreviewEl);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sidechats-close";
    closeBtn.setAttribute("aria-label", "Close side chat");
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.addEventListener("click", () => close());

    header.append(headerText, closeBtn);

    bodyEl = document.createElement("div");
    bodyEl.className = "sidechats-body";

    const inputRow = document.createElement("div");
    inputRow.className = "sidechats-input-row";

    inputEl = document.createElement("textarea");
    inputEl.className = "sidechats-input";
    inputEl.placeholder = "Ask about this…";
    inputEl.rows = 1;
    inputEl.addEventListener("input", () => autoResize(inputEl));
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    });
    // Backstop for interference the containment listeners above can't reach —
    // e.g. a capture-phase listener on the host page's document, which fires
    // before events ever reach our shadow host. If focus lands somewhere
    // outside this panel right after leaving the input while the panel is
    // still open, claim it back rather than leaving the user typing into a
    // page they never meant to click into.
    inputEl.addEventListener("focusout", () => {
      if (reclaimingFocus) return;
      const deliberateClickElsewhere = lastMousedownWasOutsidePanel;
      queueMicrotask(() => {
        if (!panelEl.classList.contains("sidechats-open")) return;
        if (document.activeElement === host) return;
        if (deliberateClickElsewhere) return;
        reclaimingFocus = true;
        inputEl.focus();
        reclaimingFocus = false;
      });
    });

    // A screenshot pasted into the composer is the fastest path there is from
    // "look at this" to a question about it, so it is handled here rather than
    // being left to the file picker. Text pastes fall through untouched.
    inputEl.addEventListener("paste", (event) => {
      const files = imageFilesFromClipboard(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void stageFiles(files);
    });

    sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "sidechats-send";
    sendBtn.setAttribute("aria-label", "Send question");
    sendBtn.innerHTML = ICON_SEND;
    sendBtn.addEventListener("click", () => void submit());

    fileInputEl = document.createElement("input");
    fileInputEl.type = "file";
    fileInputEl.className = "sidechats-file-input";
    fileInputEl.accept = FILE_INPUT_ACCEPT;
    fileInputEl.multiple = true;
    fileInputEl.hidden = true;
    fileInputEl.addEventListener("change", () => {
      const files = Array.from(fileInputEl.files ?? []);
      // Cleared before staging so picking the same file twice in a row still
      // fires a change event the second time.
      fileInputEl.value = "";
      if (files.length > 0) void stageFiles(files);
    });

    const attachBtn = document.createElement("button");
    attachBtn.type = "button";
    attachBtn.className = "sidechats-attach";
    attachBtn.setAttribute("aria-label", "Attach an image");
    attachBtn.innerHTML = ICON_ATTACH;
    attachBtn.addEventListener("click", () => fileInputEl.click());

    trayEl = document.createElement("div");
    trayEl.className = "sidechats-tray";
    trayEl.hidden = true;

    inputRow.append(attachBtn, inputEl, sendBtn, fileInputEl);

    // The tray and the input row are one control, so they share a container and
    // a single top border rather than stacking two rules on top of each other.
    const composer = document.createElement("div");
    composer.className = "sidechats-composer";
    composer.append(trayEl, inputRow);

    panelEl.addEventListener("dragenter", (event) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth += 1;
      panelEl.classList.add("sidechats-dropping");
    });
    panelEl.addEventListener("dragover", (event) => {
      if (!isFileDrag(event.dataTransfer)) return;
      // Without preventDefault on *dragover* specifically the browser refuses
      // the drop and navigates to the file instead.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    panelEl.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) panelEl.classList.remove("sidechats-dropping");
    });
    panelEl.addEventListener("drop", (event) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth = 0;
      panelEl.classList.remove("sidechats-dropping");
      const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length > 0) void stageFiles(files);
    });

    panelEl.append(header, bodyEl, composer);
    shadowRoot.appendChild(panelEl);
  }

  function imageFilesFromClipboard(clipboardData: DataTransfer | null): File[] {
    const items = clipboardData?.items;
    if (!items) return [];
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }

  /**
   * Take raw files from a paste, a drop, or the file picker and stage whatever
   * of them can be staged. One bad file doesn't cost the user the good ones:
   * each is reported on its own through the panel's existing error surface.
   */
  async function stageFiles(files: readonly Blob[]): Promise<void> {
    ensureMounted();
    // Nothing staged here could ever be sent, and the panel is already showing
    // the reload wall that explains why.
    if (contextLost) return;
    for (const file of files) {
      if (state.pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
        renderError(TOO_MANY_IMAGES_MESSAGE);
        return;
      }
      try {
        addImage(await processImage(file));
      } catch (err) {
        renderError(
          err instanceof ImageRejectedError ? err.message : "Could not attach that image.",
        );
      }
    }
  }

  function autoResize(el: HTMLTextAreaElement): void {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  function scrollToBottom(): void {
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function renderEmptyState(): void {
    bodyEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "sidechats-empty";

    const lead = document.createElement("p");
    lead.className = "sidechats-empty-lead";
    lead.textContent = "Ask anything about this line.";

    // The reassurance is the product's whole promise, and this is the moment
    // the reader is deciding whether to trust it.
    const note = document.createElement("p");
    note.className = "sidechats-empty-note";
    note.textContent = "Your main conversation stays untouched.";

    empty.append(lead, note);
    bodyEl.appendChild(empty);
  }

  /**
   * The staged images, as thumbnails above the input. Empty means `hidden`, so
   * a composer nobody has attached anything to looks exactly as it did before
   * images existed.
   */
  function renderTray(): void {
    trayEl.innerHTML = "";
    trayEl.hidden = state.pendingImages.length === 0;

    for (const image of state.pendingImages) {
      const chip = document.createElement("div");
      chip.className = "sidechats-chip";
      chip.dataset.imageId = image.id;

      const thumb = document.createElement("img");
      thumb.className = "sidechats-chip-thumb";
      thumb.src = toDataUrl(image);
      thumb.alt = "Attached image";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "sidechats-chip-remove";
      remove.setAttribute("aria-label", "Remove attached image");
      remove.innerHTML = ICON_CHIP_REMOVE;
      remove.addEventListener("click", () => removeImage(image.id));

      chip.append(thumb, remove);
      trayEl.appendChild(chip);
    }
  }

  function removeImage(id: string): void {
    state = { ...state, pendingImages: state.pendingImages.filter((image) => image.id !== id) };
    renderTray();
  }

  /** Thumbnails for a message that carried images, built as elements — never innerHTML. */
  function renderImages(images: ImageAttachment[], className: string): HTMLDivElement {
    const gallery = document.createElement("div");
    gallery.className = className;
    // One image is the subject of the question and gets the room to be read;
    // several are a set, and letting each have that much height would push the
    // answer — the thing the user is waiting for — off the bottom of the panel.
    if (images.length > 1) gallery.classList.add("sidechats-bubble-images--multi");
    for (const image of images) {
      const img = document.createElement("img");
      img.className = "sidechats-message-image";
      img.src = toDataUrl(image);
      img.alt = "Attached image";
      gallery.appendChild(img);
    }
    return gallery;
  }

  function renderMessage(message: ChatMessage): void {
    const bubble = document.createElement("div");
    bubble.className = `sidechats-bubble sidechats-bubble--${message.role}`;
    if (message.role === "assistant") {
      // Answers come back as Markdown; the user's own question is shown
      // exactly as they typed it.
      bubble.appendChild(renderMarkdown(message.content, document));
    } else if (message.images?.length) {
      // Images above the words, matching both the order they are sent to the
      // model in and the order the user staged them.
      bubble.appendChild(renderImages(message.images, "sidechats-bubble-images"));
      if (message.content) {
        const text = document.createElement("div");
        text.className = "sidechats-bubble-text";
        text.textContent = message.content;
        bubble.appendChild(text);
      } else {
        bubble.classList.add("sidechats-bubble--media-only");
      }
    } else {
      bubble.textContent = message.content;
    }
    bodyEl.appendChild(bubble);
    scrollToBottom();
  }

  function showLoading(): void {
    loadingEl = document.createElement("div");
    loadingEl.className = "sidechats-loading";
    for (let i = 0; i < 3; i++) {
      loadingEl.appendChild(document.createElement("span"));
    }
    bodyEl.appendChild(loadingEl);
    scrollToBottom();
  }

  function hideLoading(): void {
    loadingEl?.remove();
    loadingEl = null;
  }

  function renderError(message: string): void {
    const bubble = document.createElement("div");
    bubble.className = "sidechats-bubble sidechats-bubble--error";
    bubble.textContent = message;
    bodyEl.appendChild(bubble);
    scrollToBottom();
  }

  /**
   * Terminal error state: the panel cannot reach the extension any more, and no
   * retry will change that until the page is reloaded. So say so, offer the one
   * action that works, and shut off the input rather than letting the user type
   * into something that can only fail again.
   */
  function renderExtensionReloaded(): void {
    const bubble = document.createElement("div");
    bubble.className = "sidechats-bubble sidechats-bubble--error";
    bubble.textContent = EXTENSION_RELOADED_MESSAGE;

    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "sidechats-reload";
    reload.textContent = "Reload page";
    reload.addEventListener("click", () => window.location.reload());
    bubble.appendChild(reload);

    bodyEl.appendChild(bubble);
    scrollToBottom();

    inputEl.disabled = true;
    inputEl.placeholder = "Reload the page to continue";
    sendBtn.disabled = true;
    contextLost = true;
  }

  /**
   * The excerpt the side chat is branching off. Usually the highlighted text;
   * when a region was captured with nothing selected, the picture *is* the
   * excerpt, so it takes the same slot under the same eyebrow.
   */
  function renderHeaderPreview(ctx: ContextPackage): void {
    const text = truncate(ctx.selectedText, PREVIEW_MAX_CHARS);
    headerPreviewEl.textContent = "";
    headerPreviewEl.classList.toggle("sidechats-header-preview--image", !text && !!ctx.screenshot);

    if (!text && ctx.screenshot) {
      const thumb = document.createElement("img");
      thumb.className = "sidechats-header-thumb";
      thumb.src = toDataUrl(ctx.screenshot);
      thumb.alt = "Captured region of the page";
      headerPreviewEl.appendChild(thumb);
      return;
    }

    headerPreviewEl.textContent = text;
  }

  async function submit(): Promise<void> {
    const question = inputEl.value.trim();
    const images = state.pendingImages;
    // An image with no words is a legitimate "what is this?" — the server's
    // prompt carries the question in that case.
    if ((!question && images.length === 0) || state.status === "loading" || contextLost) return;

    inputEl.value = "";
    autoResize(inputEl);

    const requestState: SideChatState = { ...state };
    const isFirstMessage = state.messages.length === 0;

    const userMessage: ChatMessage = {
      role: "user",
      content: question,
      ...(images.length > 0 ? { images } : {}),
    };
    state = {
      ...state,
      messages: [...state.messages, userMessage],
      status: "loading",
      error: undefined,
      // Staged images belong to the message now, so the tray empties as the
      // send starts rather than after it succeeds — otherwise a failed send
      // would leave them staged and they would ride along again on the retry.
      pendingImages: [],
    };
    renderTray();

    if (isFirstMessage) {
      bodyEl.innerHTML = "";
    }
    renderMessage(userMessage);
    showLoading();
    sendBtn.disabled = true;

    try {
      const result = await deps.onSubmit(question, requestState, requestState.pendingImages);
      hideLoading();
      if ("error" in result) {
        // A dead/expired sideChatId (e.g. the server's 30-minute idle sweep) must not be
        // retried forever — drop it so the next send starts a fresh chat instead of
        // permanently 404ing against a chat that no longer exists server-side.
        const chatIsGone = result.error === "Side chat not found";
        state = {
          ...state,
          status: "error",
          error: result.error,
          sideChatId: chatIsGone ? null : state.sideChatId,
        };
        renderError(result.error);
      } else {
        const assistantMessage: ChatMessage = { role: "assistant", content: result.reply };
        state = {
          ...state,
          sideChatId: result.sideChatId ?? state.sideChatId,
          messages: [...state.messages, assistantMessage],
          status: "idle",
        };
        renderMessage(assistantMessage);
      }
    } catch (err) {
      hideLoading();
      if (isContextInvalidatedError(err)) {
        // Chrome's own wording here is "Extension context invalidated.", which
        // tells the user nothing about what to do about it.
        state = { ...state, status: "error", error: EXTENSION_RELOADED_MESSAGE };
        renderExtensionReloaded();
        return;
      }
      const messageText = err instanceof Error ? err.message : "Something went wrong.";
      state = { ...state, status: "error", error: messageText };
      renderError(messageText);
    } finally {
      if (!contextLost) {
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }
  }

  function open(ctx: ContextPackage): void {
    ensureMounted();

    if (contextLost) {
      // Reopening cannot help; only a page reload can. Show the same wall.
      bodyEl.innerHTML = "";
      renderHeaderPreview(ctx);
      renderExtensionReloaded();
      panelEl.classList.add("sidechats-open");
      return;
    }

    // A new branch point is a new side chat, so anything staged for the old one
    // goes with it. That means a captured region that *seeds* a chat has to
    // arrive as `ctx.screenshot`, not as an addImage() before open() — which is
    // how Step 0's contract has it. addImage is for adding to a chat already on
    // screen.
    state = emptyState(ctx);
    hideLoading();
    renderHeaderPreview(ctx);
    renderTray();
    renderEmptyState();
    inputEl.value = "";
    autoResize(inputEl);
    panelEl.classList.add("sidechats-open");

    setTimeout(() => inputEl.focus(), 0);
  }

  function close(): void {
    panelEl?.classList.remove("sidechats-open");
  }

  function addImage(image: ImageAttachment): void {
    // Callable before the panel has ever been opened, so the composer has to
    // exist before it can be staged into.
    ensureMounted();
    if (contextLost) return;
    if (state.pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
      renderError(TOO_MANY_IMAGES_MESSAGE);
      return;
    }
    state = { ...state, pendingImages: [...state.pendingImages, image] };
    renderTray();
  }

  function isOpen(): boolean {
    return panelEl?.classList.contains("sidechats-open") ?? false;
  }

  function showError(message: string): void {
    ensureMounted();
    if (!isOpen()) {
      // Nothing that came before belongs to this message — the panel was not
      // even open. Clear rather than appending an error under a stale thread.
      bodyEl.innerHTML = "";
      panelEl.classList.add("sidechats-open");
    }
    // A capture can be the first thing to notice the extension was reloaded.
    // Route it to the terminal state rather than rendering the same sentence as
    // an ordinary bubble, so the Reload button and the shut-off input come with
    // it exactly as they do when a send is what discovers the dead context.
    if (message === EXTENSION_RELOADED_MESSAGE) {
      renderExtensionReloaded();
      return;
    }
    renderError(message);
  }

  function hideForCapture(): void {
    if (host) host.style.visibility = "hidden";
  }

  function showAfterCapture(): void {
    if (host) host.style.visibility = "";
  }

  return { open, close, addImage, hideForCapture, showAfterCapture, isOpen, showError };
}

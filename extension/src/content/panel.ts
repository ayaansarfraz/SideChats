import type { ChatMessage, ContextPackage, SideChatState } from "../shared/types";
import { EXTENSION_RELOADED_MESSAGE, isContextInvalidatedError } from "./runtime";

export type PanelDeps = {
  onSubmit: (
    question: string,
    state: SideChatState
  ) => Promise<{ reply: string; sideChatId?: string } | { error: string }>;
};

export type PanelController = {
  open: (ctx: ContextPackage) => void;
  close: () => void;
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
  };
}

export function createPanel(deps: PanelDeps): PanelController {
  let shadowRoot: ShadowRoot | null = null;
  let panelEl: HTMLDivElement;
  let headerPreviewEl: HTMLDivElement;
  let bodyEl: HTMLDivElement;
  let inputEl: HTMLTextAreaElement;
  let sendBtn: HTMLButtonElement;
  let loadingEl: HTMLDivElement | null = null;
  // Once the extension context is gone the panel is read-only until reload.
  let contextLost = false;

  let state: SideChatState = emptyState({
    selectedText: "",
    parentUserMessage: "",
    parentAiResponse: "",
  });

  function ensureMounted(): void {
    if (shadowRoot) return;

    const host = document.createElement("div");
    host.id = HOST_ID;
    document.body.appendChild(host);
    shadowRoot = host.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    shadowRoot.appendChild(styleEl);
    loadPanelCss().then((css) => {
      styleEl.textContent = css;
    });

    panelEl = document.createElement("div");
    panelEl.className = "sidechats-panel";

    const header = document.createElement("div");
    header.className = "sidechats-header";

    headerPreviewEl = document.createElement("div");
    headerPreviewEl.className = "sidechats-header-preview";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sidechats-close";
    closeBtn.setAttribute("aria-label", "Close side chat");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => close());

    header.append(headerPreviewEl, closeBtn);

    bodyEl = document.createElement("div");
    bodyEl.className = "sidechats-body";

    const inputRow = document.createElement("div");
    inputRow.className = "sidechats-input-row";

    inputEl = document.createElement("textarea");
    inputEl.className = "sidechats-input";
    inputEl.placeholder = "Ask about this...";
    inputEl.rows = 1;
    inputEl.addEventListener("input", () => autoResize(inputEl));
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    });

    sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "sidechats-send";
    sendBtn.textContent = "Send";
    sendBtn.addEventListener("click", () => void submit());

    inputRow.append(inputEl, sendBtn);
    panelEl.append(header, bodyEl, inputRow);
    shadowRoot.appendChild(panelEl);
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
    empty.textContent = "Ask a question about the highlighted text.";
    bodyEl.appendChild(empty);
  }

  function renderMessage(message: ChatMessage): void {
    const bubble = document.createElement("div");
    bubble.className = `sidechats-bubble sidechats-bubble--${message.role}`;
    bubble.textContent = message.content;
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

  async function submit(): Promise<void> {
    const question = inputEl.value.trim();
    if (!question || state.status === "loading" || contextLost) return;

    inputEl.value = "";
    autoResize(inputEl);

    const requestState: SideChatState = { ...state };
    const isFirstMessage = state.messages.length === 0;

    const userMessage: ChatMessage = { role: "user", content: question };
    state = {
      ...state,
      messages: [...state.messages, userMessage],
      status: "loading",
      error: undefined,
    };

    if (isFirstMessage) {
      bodyEl.innerHTML = "";
    }
    renderMessage(userMessage);
    showLoading();
    sendBtn.disabled = true;

    try {
      const result = await deps.onSubmit(question, requestState);
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
      headerPreviewEl.textContent = truncate(ctx.selectedText, PREVIEW_MAX_CHARS);
      renderExtensionReloaded();
      panelEl.classList.add("sidechats-open");
      return;
    }

    state = emptyState(ctx);
    hideLoading();
    headerPreviewEl.textContent = truncate(ctx.selectedText, PREVIEW_MAX_CHARS);
    renderEmptyState();
    inputEl.value = "";
    autoResize(inputEl);
    panelEl.classList.add("sidechats-open");

    setTimeout(() => inputEl.focus(), 0);
  }

  function close(): void {
    panelEl?.classList.remove("sidechats-open");
  }

  return { open, close };
}

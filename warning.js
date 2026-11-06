"use strict";

const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));
const continueButton = document.querySelector("#continue");
const strictNote = document.querySelector("#strict-note");
let delay = 0;

async function initialize() {
  const pending = await browser.storage.local.get("pendingFocusNavigation");
  const entry = (pending.pendingFocusNavigation || {})[String(tabId)];
  if (!entry || !Number.isInteger(tabId)) {
    document.querySelector("#warning-copy").textContent = "This reminder is no longer active.";
    continueButton.disabled = true;
    return;
  }
  strictNote.hidden = !entry.strictMode;
  if (entry.strictMode) {
    delay = 5;
    continueButton.disabled = true;
    const updateLabel = () => {
      continueButton.textContent = delay > 0 ? `Continue in ${delay}s` : "Continue anyway";
      if (delay === 0) continueButton.disabled = false;
      delay = Math.max(0, delay - 1);
    };
    updateLabel();
    window.setInterval(updateLabel, 1000);
  }
}

document.querySelector("#return").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "dismissFocusNavigation", tabId });
  if (history.length > 1) history.back();
  else {
    const tab = await browser.tabs.getCurrent();
    if (tab) await browser.tabs.remove(tab.id);
  }
});
continueButton.addEventListener("click", async () => {
  if (continueButton.disabled) return;
  const result = await browser.runtime.sendMessage({ type: "resolveFocusNavigation", tabId });
  if (result && result.error) {
    document.querySelector("#warning-copy").textContent = result.error;
    continueButton.disabled = true;
  }
});

initialize().catch(error => {
  console.error("Could not load focus-session warning:", error);
  document.querySelector("#warning-copy").textContent = "The reminder could not be loaded. Return to your previous page or close this tab.";
  continueButton.disabled = true;
});

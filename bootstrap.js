/* eslint-disable no-undef */
/**
 * DualTran Translate — Zotero 7 bootstrap.
 *
 * Adds one Tools-menu entry that translates the selected item's title and abstract into a child
 * note, keeping the original text above the translation. Settings live under
 * `extensions.zotero.dualtran.*` so they can be set from the Config Editor without a preference
 * pane (a pane is the next milestone).
 */

if (typeof Zotero == "undefined") {
  var Zotero;
}

var DualTran;
var DualTranCore;

function log(msg) {
  Zotero.debug("DualTran: " + msg);
}

const MENU_ID = "dualtran-translate-item";

function pref(key, fallback) {
  const value = Zotero.Prefs.get("dualtran." + key, true);
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function config() {
  return {
    engine: pref("engine", "google"),
    target: pref("target", "zh-CN"),
    endpoint: pref("endpoint", "https://api.openai.com/v1"),
    apiKey: pref("apiKey", ""),
    model: pref("model", "gpt-4o-mini"),
  };
}

/** Privileged request: Zotero.HTTP goes through the app, so there is no CORS wall. */
async function translateText(text) {
  const settings = config();
  const options = { text: text, target: settings.target };

  if (settings.engine === "google") {
    const url = DualTranCore.googleUrl(options);
    const response = await Zotero.HTTP.request("GET", url, { responseType: "json" });
    return DualTranCore.parseGoogleResponse(response.response);
  }

  const request = DualTranCore.buildChatRequest(
    { endpoint: settings.endpoint, apiKey: settings.apiKey, model: settings.model },
    options
  );
  const response = await Zotero.HTTP.request("POST", request.url, {
    body: request.body,
    headers: request.headers,
    responseType: "json",
  });
  return DualTranCore.parseChatResponse(response.response);
}

async function translateChunked(text) {
  const chunks = DualTranCore.chunkText(text);
  const out = [];
  for (const chunk of chunks) out.push(await translateText(chunk));
  return out.join("\n\n");
}

async function translateSelected() {
  const items = Zotero.getActiveZoteroPane().getSelectedItems();
  if (!items.length) {
    Zotero.getMainWindow().alert("Select an item first.");
    return;
  }
  for (const item of items) {
    if (!item.isRegularItem()) continue;
    try {
      const title = item.getField("title");
      const abstractText = item.getField("abstractNote");
      if (!title && !abstractText) continue;

      const translatedTitle = title ? await translateChunked(title) : "";
      const translatedAbstract = abstractText ? await translateChunked(abstractText) : "";
      const html = DualTranCore.buildNoteHtml(title, abstractText, translatedTitle, translatedAbstract);

      const note = new Zotero.Item("note");
      note.libraryID = item.libraryID;
      note.parentID = item.id;
      note.setNote(html);
      await note.saveTx();
      log("note created for item " + item.id);
    }
    catch (error) {
      log("translation failed for item " + item.id + ": " + (error && error.message ? error.message : error));
      Zotero.getMainWindow().alert("DualTran: " + (error && error.message ? error.message : error));
    }
  }
}

function installMenu(win) {
  const doc = win.document;
  if (doc.getElementById(MENU_ID)) return;
  const popup = doc.getElementById("menu_ToolsPopup");
  if (!popup) return;
  const menuitem = doc.createXULElement("menuitem");
  menuitem.id = MENU_ID;
  menuitem.setAttribute("label", "DualTran: translate title and abstract");
  menuitem.addEventListener("command", () => {
    translateSelected().catch((error) => log("unhandled: " + error));
  });
  popup.appendChild(menuitem);
  log("tools menu installed");
}

function removeMenu(win) {
  const el = win.document.getElementById(MENU_ID);
  if (el) el.remove();
}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "content/translate.js", this);
  DualTranCore = globalThis.DualTranCore;
  log("starting " + id + " " + version);

  const install = () => {
    for (const win of Zotero.getMainWindows()) installMenu(win);
  };
  install();
  Zotero.Plugins.addObserver({
    shutdown: ({ id: closedId }) => {
      if (closedId === id) {
        for (const win of Zotero.getMainWindows()) removeMenu(win);
      }
    },
  });
}

function shutdown({ id, version, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;
  for (const win of Zotero.getMainWindows()) removeMenu(win);
  log("shutdown");
}

function install() {}

function uninstall() {}

var DualTranBootstrap = { startup, shutdown, install, uninstall };

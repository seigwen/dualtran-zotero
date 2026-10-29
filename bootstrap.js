/* eslint-disable no-undef */
/**
 * DualTran Translate — Zotero 7+ bootstrap.
 *
 * Adds one Tools-menu entry that translates the selected items' title and abstract into child
 * notes, keeping the source text above the translation. Settings live under
 * `extensions.zotero.dualtran.*`; prefs.js registers the defaults so they show up in the
 * Config Editor without a preference pane.
 */

if (typeof Zotero == "undefined") {
  var Zotero;
}

var DualTranCore;

const MENU_ID = "dualtran-translate-item";
const MENU_LABEL = "DualTran: translate title and abstract";
const PROGRESS_HEADLINE = "DualTran";

let running = false;
let windowObserver = null;

function log(msg) {
  Zotero.debug("DualTran: " + msg);
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  const message = error.message || String(error);
  return error.status ? message + " (HTTP " + error.status + ")" : message;
}

function alertUser(win, message) {
  try {
    if (typeof Zotero.alert === "function") {
      Zotero.alert(win || null, "DualTran", message);
    } else {
      (win || Zotero.getMainWindow()).alert(message);
    }
  } catch (error) {
    log("alert failed: " + errorMessage(error));
  }
}

/** Read the configuration, which also validates the engine and endpoint. */
function config() {
  return DualTranCore.readConfig(function (key) {
    return Zotero.Prefs.get(key, true);
  });
}

/** 0.1.2 stored settings at the root (`dualtran.*`); move them into the plugin namespace. */
function migratePrefs() {
  const migrated = DualTranCore.migrateLegacyPrefs({
    hasUserValue: function (key) {
      return Services.prefs.prefHasUserValue(key);
    },
    get: function (key) {
      return Zotero.Prefs.get(key, true);
    },
    set: function (key, value) {
      Zotero.Prefs.set(key, value, true);
    },
    clear: function (key) {
      Services.prefs.clearUserPref(key);
    },
  });
  if (migrated.length) log("migrated legacy prefs: " + migrated.join(", "));
}

async function translateText(text, settings) {
  if (settings.engine === "google") {
    const url = DualTranCore.googleUrl({ text: text, target: settings.target });
    const response = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: settings.timeout,
    });
    return DualTranCore.parseGoogleResponse(response.response);
  }

  const request = DualTranCore.buildChatRequest(
    { endpoint: settings.endpoint, apiKey: settings.apiKey, model: settings.model },
    { text: text, target: settings.target }
  );
  const response = await Zotero.HTTP.request("POST", request.url, {
    body: request.body,
    headers: request.headers,
    responseType: "json",
    timeout: settings.timeout,
  });
  return DualTranCore.parseChatResponse(response.response);
}

async function translateChunked(text, settings) {
  const chunks = DualTranCore.chunkText(text, DualTranCore.chunkLimitFor(settings.engine));
  const out = [];
  for (const chunk of chunks) out.push(await translateText(chunk, settings));
  return out.join("\n\n");
}

/** Translate one regular item into a child note. Returns false when there is nothing to do. */
async function translateItem(item, settings) {
  const title = item.getField("title");
  const abstractText = item.getField("abstractNote");
  if (!title && !abstractText) return false;

  const translatedTitle = title ? await translateChunked(title, settings) : "";
  const translatedAbstract = abstractText ? await translateChunked(abstractText, settings) : "";

  const note = new Zotero.Item("note");
  note.libraryID = item.libraryID;
  note.parentID = item.id;
  note.setNote(DualTranCore.buildNoteHtml(title, abstractText, translatedTitle, translatedAbstract));
  await note.saveTx();
  return true;
}

async function translateSelected(win) {
  if (running) return;

  const pane = (win && win.ZoteroPane) || Zotero.getActiveZoteroPane();
  const selected = pane.getSelectedItems();
  const items = DualTranCore.resolveTargets(selected, function (id) {
    return Zotero.Items.get(id);
  });
  if (!items.length) {
    alertUser(win, DualTranCore.selectionHint(selected) || "Nothing to translate in this selection.");
    return;
  }

  let settings;
  try {
    settings = config();
  } catch (error) {
    alertUser(win, errorMessage(error));
    return;
  }

  running = true;
  const menu = win.document.getElementById(MENU_ID);
  if (menu) menu.disabled = true;

  const progress = new Zotero.ProgressWindow({ closeOnClick: false });
  progress.changeHeadline(PROGRESS_HEADLINE);
  progress.show();

  const failures = [];
  let created = 0;
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const label = item.getField("title") || "item " + item.id;
      progress.changeHeadline(PROGRESS_HEADLINE + " — " + (index + 1) + "/" + items.length);
      progress.addDescription(label);
      try {
        if (await translateItem(item, settings)) created += 1;
        else log("skipping item without title or abstract: " + item.id);
      } catch (error) {
        log("translation failed for item " + item.id + ": " + errorMessage(error));
        failures.push(label + ": " + errorMessage(error));
      }
    }
  } finally {
    running = false;
    const current = win.document.getElementById(MENU_ID);
    if (current) current.disabled = false;
    if (failures.length) {
      progress.changeHeadline(PROGRESS_HEADLINE + " — " + failures.length + " failed");
      progress.startCloseTimer(8000);
    } else {
      progress.changeHeadline(PROGRESS_HEADLINE + " — " + created + " note(s) created");
      progress.startCloseTimer(4000);
    }
  }

  if (failures.length) {
    alertUser(win, "DualTran could not translate:\n\n" + failures.join("\n"));
  }
}

function installMenu(win) {
  const doc = win && win.document;
  if (!doc || doc.getElementById(MENU_ID)) return false;
  const popup = doc.getElementById("menu_ToolsPopup");
  if (!popup) {
    log("Tools menu not found in this window");
    return false;
  }
  const menuitem = doc.createXULElement("menuitem");
  menuitem.id = MENU_ID;
  menuitem.setAttribute("label", MENU_LABEL);
  menuitem.addEventListener("command", function () {
    translateSelected(win).catch(function (error) {
      log("unhandled: " + errorMessage(error));
    });
  });
  popup.appendChild(menuitem);
  log("tools menu installed");
  return true;
}

function removeMenu(win) {
  const el = win && win.document ? win.document.getElementById(MENU_ID) : null;
  if (el) el.remove();
}

/** Windows opened after startup (File → New Window) need the menu too. */
function startWindowObserver() {
  if (windowObserver) return;
  windowObserver = {
    observe: function (subject, topic) {
      if (topic !== "domwindowopened") return;
      const win = subject;
      try {
        win.addEventListener(
          "load",
          function () {
            try {
              if (win.ZoteroPane) installMenu(win);
            } catch (error) {
              log("menu install failed: " + errorMessage(error));
            }
          },
          { once: true }
        );
      } catch (error) {
        log("window observer failed: " + errorMessage(error));
      }
    },
  };
  Services.ww.registerNotification(windowObserver);
}

function stopWindowObserver() {
  if (!windowObserver) return;
  try {
    Services.ww.unregisterNotification(windowObserver);
  } catch (error) {
    log("window observer cleanup failed: " + errorMessage(error));
  }
  windowObserver = null;
}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "content/translate.js", this);
  DualTranCore = globalThis.DualTranCore;
  if (!DualTranCore) throw new Error("DualTran: translation core failed to load");

  try {
    migratePrefs();
  } catch (error) {
    log("pref migration failed: " + errorMessage(error));
  }

  log("starting " + id + " " + version + " (settings " + DualTranCore.PREF_PREFIX + "*)");
  for (const win of Zotero.getMainWindows()) installMenu(win);
  startWindowObserver();
}

function shutdown({ id, version, rootURI }, reason) {
  stopWindowObserver();
  if (reason === APP_SHUTDOWN) return;
  for (const win of Zotero.getMainWindows()) removeMenu(win);
  log("shutdown");
}

function install() {}

function uninstall() {}

var DualTranBootstrap = { startup, shutdown, install, uninstall };

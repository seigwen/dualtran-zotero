/* eslint-disable no-undef */
/**
 * DualTran Translate — Zotero 7+ bootstrap.
 *
 * Three surfaces:
 *   - Tools → DualTran submenu: translate an item's title and abstract into a child note,
 *     replace the fields (with a backup note), append the translation, or create a copy.
 *   - Reader text-selection popup: annotation / sticky note / child note for selected text.
 *   - Startup: prefs migration, localisation, menu injection (including new windows).
 */

if (typeof Zotero == "undefined") {
  var Zotero;
}

var DualTranCore;
var DualTranI18n;

const PLUGIN_ID = "dualtran@seigwen.dev";
const MENU_ID = "dualtran-menu";
const READER_EVENT = "renderTextSelectionPopup";
const ANNOTATION_COLOR = "#2ea8e5";

const ACTION_IDS = {
  note: "dualtran-action-note",
  replace: "dualtran-action-replace",
  append: "dualtran-action-append",
  newItem: "dualtran-action-new-item",
};

const ACTION_LABEL_KEYS = {
  note: "menu.note",
  replace: "menu.replace",
  append: "menu.append",
  newItem: "menu.newItem",
};

const READER_MODES = [
  { mode: "highlight", labelKey: "reader.highlight" },
  { mode: "sticky", labelKey: "reader.sticky", pdfOnly: true },
  { mode: "note", labelKey: "reader.note" },
];

let running = false;
let windowObserver = null;
let readerListener = null;

function log(msg) {
  Zotero.debug("DualTran: " + msg);
}

function t(key, params) {
  return DualTranI18n.t(key, params);
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

/** Load `locales/<code>.json`, trying zh_CN → zh → en before falling back to raw keys. */
async function loadTranslations(rootURI) {
  const locale = String(Zotero.locale || "en");
  const candidates = [locale.replace(/-/g, "_"), locale.split(/[-_]/)[0], "en"];
  for (const code of candidates) {
    try {
      const text = await Zotero.File.getResourceAsync(rootURI + "locales/" + code + ".json");
      DualTranI18n.set(JSON.parse(text));
      log("locale " + code + " loaded");
      return;
    } catch (error) {
      // Try the next candidate
    }
  }
  DualTranI18n.set({});
  log("no locale dictionary found for " + locale);
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

async function translateMetadata(item, settings) {
  const title = item.getField("title");
  const abstractText = item.getField("abstractNote");
  return {
    title: title,
    abstractText: abstractText,
    translatedTitle: title ? await translateChunked(title, settings) : "",
    translatedAbstract: abstractText ? await translateChunked(abstractText, settings) : "",
  };
}

function noteLabels() {
  return {
    originalAbstract: t("note.originalAbstract"),
    translation: t("note.translation"),
  };
}

function backupLabels() {
  return {
    heading: t("backup.heading"),
    title: t("backup.title"),
    abstract: t("backup.abstract"),
    saved: t("backup.saved"),
  };
}

function appendLabels() {
  return {
    heading: t("append.heading"),
    title: t("append.title"),
    abstract: t("append.abstract"),
  };
}

async function addChildNote(item, html) {
  const note = new Zotero.Item("note");
  note.libraryID = item.libraryID;
  note.parentID = item.id;
  note.setNote(html);
  await note.saveTx();
  return note;
}

function utcStamp() {
  return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

async function applyItemAction(action, item, settings) {
  const fields = await translateMetadata(item, settings);

  if (action === "note") {
    await addChildNote(
      item,
      DualTranCore.buildNoteHtml(
        fields.title,
        fields.abstractText,
        fields.translatedTitle,
        fields.translatedAbstract,
        noteLabels()
      )
    );
    return;
  }

  if (action === "replace") {
    await addChildNote(
      item,
      DualTranCore.buildBackupNote(fields, settings.target, utcStamp(), backupLabels())
    );
    item.setField("title", fields.translatedTitle || fields.title);
    item.setField("abstractNote", fields.translatedAbstract || fields.abstractText || "");
    await item.saveTx();
    return;
  }

  if (action === "append") {
    item.setField(
      "abstractNote",
      DualTranCore.buildAppendText(
        fields.abstractText,
        fields.translatedTitle,
        fields.translatedAbstract,
        settings.target,
        appendLabels()
      )
    );
    await item.saveTx();
    return;
  }

  if (action === "newItem") {
    const copy = item.clone(null, { includeCollections: true });
    const next = DualTranCore.buildTranslatedItemFields(
      fields,
      { title: fields.translatedTitle, abstract: fields.translatedAbstract },
      settings.target
    );
    copy.setField("title", next.title);
    copy.setField("abstractNote", next.abstractNote);
    copy.setField("language", next.language);
    await copy.saveTx();
    if (item.addRelatedItem(copy)) await item.saveTx({ skipDateModifiedUpdate: true });
    if (copy.addRelatedItem(item)) await copy.saveTx({ skipDateModifiedUpdate: true });
    return;
  }

  throw new Error("Unknown action: " + action);
}

async function runItemAction(win, action) {
  if (running) return;

  const pane = (win && win.ZoteroPane) || Zotero.getActiveZoteroPane();
  const selected = pane.getSelectedItems();
  const items = DualTranCore.resolveTargets(selected, function (id) {
    return Zotero.Items.get(id);
  });
  if (!items.length) {
    const problem = DualTranCore.selectionProblem(selected);
    alertUser(win, problem ? t("hint." + problem) : t("hint.nothing"));
    return;
  }

  let settings;
  try {
    settings = config();
  } catch (error) {
    alertUser(win, errorMessage(error));
    return;
  }

  if (action === "replace") {
    const message = t("confirm.replace", { count: items.length });
    let choice;
    if (Zotero.Prompt && typeof Zotero.Prompt.confirm === "function") {
      choice = Zotero.Prompt.confirm({
        window: win,
        title: t("confirm.title"),
        text: message,
        button0: t("confirm.ok"),
        button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
        defaultButton: 0,
      });
    } else {
      choice = Services.prompt.confirm(win, t("confirm.title"), message) ? 0 : 1;
    }
    if (choice !== 0) return;
  }

  running = true;
  const menu = win && win.document ? win.document.getElementById(MENU_ID) : null;
  if (menu) menu.disabled = true;

  const progress = new Zotero.ProgressWindow({ closeOnClick: false });
  progress.changeHeadline(t("progress.headline"));
  progress.show();

  const failures = [];
  let done = 0;
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const label = item.getField("title") || "item " + item.id;
      progress.changeHeadline(t("progress.item", { current: index + 1, total: items.length }));
      progress.addDescription(label);
      try {
        await applyItemAction(action, item, settings);
        done += 1;
      } catch (error) {
        log("action " + action + " failed for item " + item.id + ": " + errorMessage(error));
        failures.push(label + ": " + errorMessage(error));
      }
    }
  } finally {
    running = false;
    if (menu) menu.disabled = false;
    if (failures.length) {
      progress.changeHeadline(t("progress.failed", { count: failures.length }));
      progress.startCloseTimer(8000);
    } else {
      progress.changeHeadline(t("progress.done", { count: done }));
      progress.startCloseTimer(4000);
    }
  }

  if (failures.length) {
    alertUser(win, "DualTran:\n\n" + failures.join("\n"));
  }
}

function installMenu(win) {
  const doc = win && win.document;
  if (!doc || doc.getElementById(MENU_ID)) return false;
  const tools = doc.getElementById("menu_ToolsPopup");
  if (!tools) {
    log("Tools menu not found in this window");
    return false;
  }

  const menu = doc.createXULElement("menu");
  menu.id = MENU_ID;
  menu.setAttribute("label", t("menu.root"));

  const popup = doc.createXULElement("menupopup");
  menu.appendChild(popup);

  for (const action of ["note", "replace", "append", "newItem"]) {
    const item = doc.createXULElement("menuitem");
    item.id = ACTION_IDS[action];
    item.setAttribute("label", t(ACTION_LABEL_KEYS[action]));
    item.addEventListener("command", function () {
      runItemAction(win, action).catch(function (error) {
        log("unhandled: " + errorMessage(error));
      });
    });
    popup.appendChild(item);
  }

  tools.appendChild(menu);
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

/* ------------------------------------------------------------------ reader */

function installReaderListener() {
  if (readerListener) return;
  readerListener = function (event) {
    onSelectionPopup(event).catch(function (error) {
      log("reader popup failed: " + errorMessage(error));
    });
  };
  Zotero.Reader.registerEventListener(READER_EVENT, readerListener, PLUGIN_ID);
}

function removeReaderListener() {
  if (!readerListener) return;
  try {
    Zotero.Reader.unregisterEventListener(READER_EVENT, readerListener);
  } catch (error) {
    log("reader listener cleanup failed: " + errorMessage(error));
  }
  readerListener = null;
}

function popupButton(doc, label) {
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute(
    "style",
    "font:inherit;font-size:12px;padding:2px 8px;border:1px solid rgba(128,128,128,.45);" +
      "border-radius:4px;background:transparent;color:inherit;cursor:pointer;"
  );
  return button;
}

async function onSelectionPopup(event) {
  const reader = event && event.reader;
  const doc = event && event.doc;
  const append = event && event.append;
  const annotation = event && event.params && event.params.annotation;
  if (!reader || !doc || typeof append !== "function") return;
  if (!annotation || !annotation.text || !String(annotation.text).trim()) return;

  const attachment = Zotero.Items.get(reader.itemID);
  if (!attachment || !attachment.isFileAttachment()) return;

  const box = doc.createElement("div");
  box.setAttribute("style", "margin-top:8px;font:12px system-ui,-apple-system,sans-serif;");

  const label = doc.createElement("div");
  label.textContent = t("reader.title");
  label.setAttribute(
    "style",
    "font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.6;margin-bottom:4px;"
  );
  box.appendChild(label);

  const row = doc.createElement("div");
  row.setAttribute("style", "display:flex;flex-wrap:wrap;gap:4px;");
  box.appendChild(row);

  for (const entry of READER_MODES) {
    if (entry.pdfOnly && reader.type !== "pdf") continue;
    const button = popupButton(doc, t(entry.labelKey));
    button.addEventListener("click", function (clickEvent) {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      runReaderAction(button, entry.mode, reader, attachment, annotation).catch(function (error) {
        button.disabled = false;
        button.textContent = t("reader.error");
        button.title = errorMessage(error);
        log("reader action failed: " + errorMessage(error));
      });
    });
    row.appendChild(button);
  }

  append(box);
}

async function runReaderAction(button, mode, reader, attachment, annotation) {
  if (button.dataset.busy) return;
  button.dataset.busy = "1";
  button.disabled = true;
  button.textContent = t("reader.loading");

  try {
    const settings = config();
    const translation = await translateChunked(annotation.text, settings);

    if (mode === "note") {
      const parent = attachment.parentItem || attachment;
      const note = new Zotero.Item("note");
      note.libraryID = parent.libraryID;
      note.parentID = parent.id;
      note.setNote(DualTranCore.buildSelectionNote(annotation.text, translation));
      await note.saveTx();
      button.textContent = t("reader.doneNote");
    } else {
      const json = DualTranCore.buildAnnotation(annotation, translation, mode, {
        color: ANNOTATION_COLOR,
        generateKey: function () {
          return Zotero.DataObjectUtilities.generateKey();
        },
      });
      await Zotero.Annotations.saveFromJSON(attachment, json);
      button.textContent = t(mode === "sticky" ? "reader.doneSticky" : "reader.doneHighlight");
    }
  } catch (error) {
    button.textContent = t("reader.error");
    button.title = errorMessage(error);
    log("reader action failed: " + errorMessage(error));
  } finally {
    button.disabled = false;
    delete button.dataset.busy;
  }
}

/* ---------------------------------------------------------------- startup */

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "content/i18n.js", this);
  Services.scriptloader.loadSubScript(rootURI + "content/translate.js", this);
  DualTranI18n = globalThis.DualTranI18n;
  DualTranCore = globalThis.DualTranCore;
  if (!DualTranCore || !DualTranI18n) throw new Error("DualTran: core failed to load");

  await loadTranslations(rootURI);

  try {
    migratePrefs();
  } catch (error) {
    log("pref migration failed: " + errorMessage(error));
  }

  log("starting " + id + " " + version + " locale=" + Zotero.locale);
  for (const win of Zotero.getMainWindows()) installMenu(win);
  startWindowObserver();
  installReaderListener();
}

function shutdown({ id, version, rootURI }, reason) {
  stopWindowObserver();
  removeReaderListener();
  if (reason === APP_SHUTDOWN) return;
  for (const win of Zotero.getMainWindows()) removeMenu(win);
  log("shutdown");
}

function install() {}

function uninstall() {}

var DualTranBootstrap = { startup, shutdown, install, uninstall };

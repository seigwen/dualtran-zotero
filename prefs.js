/*
 * Default preferences for DualTran Translate.
 *
 * Zotero loads this file into the default pref branch on every start, so these values show up
 * in Settings → Advanced → Config Editor and can be edited there without a preference pane.
 * A pref the user has set always wins over the default.
 *
 * SPEC 2.1: a fresh install has NO AI provider, so `aiProvider`, `aiBaseUrl` and `aiModel` have
 * no default worth shipping — leaving them unset is what makes the preference pane render its
 * "Select a provider" state instead of pointing the add-on at OpenAI behind the user's back.
 */
pref("extensions.zotero.dualtran.engine", "google");
pref("extensions.zotero.dualtran.target", "zh-CN");
pref("extensions.zotero.dualtran.aiProvider", "");
pref("extensions.zotero.dualtran.aiBaseUrl", "");
pref("extensions.zotero.dualtran.aiModel", "");
pref("extensions.zotero.dualtran.aiReasoningDepth", "lowest");
pref("extensions.zotero.dualtran.apiKey", "");
pref("extensions.zotero.dualtran.endpoint", "");
pref("extensions.zotero.dualtran.model", "");
pref("extensions.zotero.dualtran.timeout", 120000);

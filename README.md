# DualTran Translate for Zotero

Translate a paper's title and abstract without losing the source. One command in Zotero's Tools
menu creates a child note containing the original title and abstract followed by the translation.

- **Google Translate** — no key, no configuration.
- **AI** — any OpenAI-compatible endpoint with your own key (OpenAI, DeepSeek, OpenRouter, a
  local Ollama server, …). Zotero's privileged HTTP has no CORS wall, so localhost works.

This add-on is independent of the DualTran browser extension; it keeps its own settings.

## Requirements

- Zotero 7, 8, 9 or 10. Verified end to end on Zotero **10.0.6** (Linux).
- Internet access to `translate.googleapis.com` (Google engine) or to your AI endpoint.

## Install

1. Download `dualtran-zotero.xpi` from the [latest release](https://github.com/seigwen/dualtran-zotero/releases/latest).
2. Install it from the plugin manager:
   - **Zotero 10:** Tools → **Plugins** → ⚙ → **Install Plugin From File…**
   - **Zotero 7–9:** Tools → **Add-ons** → ⚙ → **Install Add-on From File…**
3. Restart Zotero. The entry appears under **Tools → “DualTran: translate title and abstract”**.

Zotero 10 refuses add-ons that do not declare an update manifest; this one does, so future
releases are offered as normal add-on updates.

## Use

1. Select one or more items in the item list. Selecting a PDF, an attachment or a child note
   resolves to its parent item, so you can click the PDF you are reading.
2. Choose **Tools → “DualTran: translate title and abstract”**.
3. A progress window shows which item is being translated. Each item gets a child note:

```
H1  original title
H2  translated title
H3  Original abstract
    original abstract
H3  Translation
    translated abstract
```

The command runs item by item. A failure on one item does not stop the rest; failures are
collected and shown once at the end.

The default target language is Simplified Chinese (`zh-CN`). See below to change it.

## Settings

There is no preference pane yet. Settings live in Zotero's Config Editor:

**Edit → Settings → Advanced → Config Editor** (macOS: **Zotero → Settings**).

Search for `extensions.zotero.dualtran` — the defaults are registered by the add-on, so every key
below is already listed with its default value. Edit a row in place; the next run picks the value
up, no restart needed.

| Pref (under `extensions.zotero.dualtran.`) | Default | Meaning |
| --- | --- | --- |
| `engine` | `google` | `google` or `ai`. Any other value is rejected with an error. |
| `target` | `zh-CN` | Target language code passed to the engine (`en`, `ja`, `de`, …). |
| `endpoint` | `https://api.openai.com/v1` | Base URL of the AI endpoint. |
| `apiKey` | empty | Bearer token for the AI endpoint. Leave empty for local servers. |
| `model` | `gpt-4o-mini` | Model id sent to the AI endpoint. |
| `timeout` | `120000` | Request timeout in milliseconds. |

`endpoint` accepts `https://api.openai.com/v1`, `https://api.deepseek.com`,
`http://127.0.0.1:11434/v1`, or a full `…/chat/completions` URL. A URL ending in `/v1` gets
`/chat/completions` appended; a bare host gets `/v1/chat/completions`.

Examples:

| Provider | `endpoint` | `model` | `apiKey` |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | required |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | required |
| OpenRouter | `https://openrouter.ai/api/v1` | e.g. `anthropic/claude-3.5-sonnet` | required |
| Ollama (local) | `http://127.0.0.1:11434/v1` | a model you have pulled | empty |

Set `engine` to `ai` after filling in the endpoint, key and model.

### Upgrading from 0.1.2

0.1.2 read its settings from root-level `dualtran.*` prefs by mistake, so the AI settings
documented for it were ignored. On first start, 0.1.3 copies any root-level setting into
`extensions.zotero.dualtran.*` and removes the old key. Nothing to do by hand.

## What it does not do

- It does not translate PDF full text — only the item's title and abstract fields.
- It does not update an existing note. Every run creates a new child note, so running it twice on
  the same item produces two notes; delete the one you do not want.
- Items with neither a title nor an abstract are skipped silently (a line goes to the debug log).
- It cannot be cancelled once started.
- UI strings are currently English only.

## Troubleshooting

- **The Tools entry is missing.** Check that the add-on is enabled in Tools → Plugins (Add-ons in
  Zotero 7–9) and restart Zotero. For diagnosis, enable **Help → Debug Output Logging → View
  Output** and search for `DualTran:`; startup logs the version and the pref namespace.
- **“Unknown engine …”.** `engine` must be exactly `google` or `ai`.
- **HTTP 401 / 403.** Wrong or missing `apiKey` for the selected endpoint.
- **HTTP 404.** Usually a wrong `endpoint` or `model`; check the provider's base URL.
- **Google returns nothing / times out.** The Google endpoint is unreachable on some networks;
  switch to the `ai` engine.
- **Empty translation.** The provider answered with empty content; try another model.
- Request errors are also written to the debug output, including the item id.

## Privacy

The title and abstract of the selected items are sent to `translate.googleapis.com` when the
Google engine is active, or to the endpoint you configure when the AI engine is active. Nothing
else leaves the machine: settings are stored in Zotero's prefs, there is no telemetry, and the
add-on makes no other network requests.

## Development

```bash
npm install
npm test        # vitest: 28 unit tests over the translation core
npm run build   # writes dualtran-zotero.xpi
```

Layout:

| Path | Role |
| --- | --- |
| `bootstrap.js` | Zotero entry point: menu item, progress window, HTTP, note creation |
| `content/translate.js` | pure, testable core: prefs, endpoints, chunking, parsing, note HTML, selection |
| `prefs.js` | default prefs, loaded by Zotero into the default branch on every start |
| `manifest.json` | add-on id, compatibility range, update manifest URL |
| `updates.json` | update manifest served from `master`; add an entry per release |

`npm run build` packages only runtime files (`manifest.json`, `bootstrap.js`, `prefs.js`,
`content/`).

## Licence

MPL-2.0. See [LICENSE](LICENSE).

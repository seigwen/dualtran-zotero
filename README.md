# DualTran Translate for Zotero

**Translate a paper's title and abstract without losing the source.** One Tools-menu command
creates a child note with the original title and abstract, then the translation underneath.

- **Google Translate** — no key, no configuration
- **AI** — any OpenAI-compatible endpoint with your own key (OpenAI, DeepSeek, OpenRouter,
  local Ollama: Zotero's privileged HTTP has no CORS wall)

## Install

Build the `.xpi` and install it from Zotero:

```bash
zip -r dualtran-zotero.xpi manifest.json bootstrap.js content/
```

Zotero → **Tools → Add-ons → ⚙ → Install Add-on From File…** → pick the `.xpi`.

## Configuration

Set preferences in **Settings → Advanced → Config Editor** (they live under `extensions.zotero.dualtran`):

| Pref | Default | Notes |
|---|---|---|
| `engine` | `google` | `google` or `ai` |
| `target` | `zh-CN` | target language code |
| `endpoint` | `https://api.openai.com/v1` | base URL for the AI engine |
| `apiKey` | empty | bearer token |
| `model` | `gpt-4o-mini` | model id |

## Usage

Select one or more items → **Tools → DualTran: translate title and abstract**. Each item gets a
child note containing the original text and the translation.

## Status

- 10 unit tests over the translation core (`npm test`).
- The bootstrap adds a Tools menu item; **not yet verified inside the Zotero desktop app**.

## Licence

MPL-2.0.

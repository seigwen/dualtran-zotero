import { describe, expect, it } from "vitest";
import core from "../content/translate.js";

describe("endpoint handling", () => {
  it("rejects a schemeless endpoint", () => {
    expect(() => core.normalizeEndpoint("api.openai.com/v1")).toThrow(/must start with http/);
  });
  it("appends the missing path", () => {
    expect(core.chatCompletionsUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/chat/completions");
    expect(core.chatCompletionsUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(core.chatCompletionsUrl("https://x/api/v1/chat/completions")).toBe("https://x/api/v1/chat/completions");
  });
});

describe("chat request", () => {
  it("names the target language and keeps the payload minimal", () => {
    const request = core.buildChatRequest(
      { endpoint: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o-mini" },
      { text: "Hello", target: "zh-CN" }
    );
    const body = JSON.parse(request.body);
    expect(body.messages[0].content).toContain("zh-CN");
    expect(body.messages[1].content).toBe("Hello");
    expect(request.headers.Authorization).toBe("Bearer k");
  });
});

describe("response parsing", () => {
  it("reads the first choice", () => {
    expect(core.parseChatResponse({ choices: [{ message: { content: "你好" } }] })).toBe("你好");
  });
  it("surfaces provider errors", () => {
    expect(() => core.parseChatResponse({ error: { message: "bad key" } })).toThrow("bad key");
  });
  it("refuses an empty translation", () => {
    expect(() => core.parseChatResponse({ choices: [{ message: { content: "  " } }] })).toThrow(/empty/);
  });
  it("joins Google sentence pieces", () => {
    expect(core.parseGoogleResponse([[["你好", "Hello"], ["世界", " world"]], null, "en"])).toBe("你好世界");
  });
});

describe("chunking", () => {
  it("keeps short text whole", () => {
    expect(core.chunkText("hello")).toEqual(["hello"]);
  });
  it("splits oversized text without losing characters", () => {
    const text = "x".repeat(250);
    expect(core.chunkText(text, 100)).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
  });
});

describe("note html", () => {
  it("puts the source above the translation and escapes markup", () => {
    const html = core.buildNoteHtml("A <b>title</b>", "Abstract & more", "标题", "摘要");
    expect(html.indexOf("A &lt;b&gt;title&lt;/b&gt;")).toBeGreaterThan(-1);
    expect(html.indexOf("Original abstract")).toBeGreaterThan(-1);
    expect(html.indexOf("Translation")).toBeGreaterThan(-1);
    expect(html.indexOf("摘要")).toBeGreaterThan(-1);
  });
  it("omits the heading when an item has no title", () => {
    const html = core.buildNoteHtml("", "An abstract", "", "一段摘要");
    expect(html).not.toContain("<h1></h1>");
    expect(html).toContain("Original abstract");
    expect(html).toContain("一段摘要");
  });
});

const PREF = "extensions.zotero.dualtran.";

describe("preferences", () => {
  it("reads every key from the scoped Zotero namespace", () => {
    const seen = [];
    const config = core.readConfig((key) => {
      seen.push(key);
      if (key === PREF + "engine") return "ai";
      if (key === PREF + "model") return "deepseek-chat";
      return undefined;
    });
    expect(seen).toEqual(
      expect.arrayContaining([
        PREF + "engine",
        PREF + "target",
        PREF + "endpoint",
        PREF + "apiKey",
        PREF + "model",
        PREF + "timeout",
      ])
    );
    expect(config.engine).toBe("ai");
    expect(config.model).toBe("deepseek-chat");
    expect(config.target).toBe("zh-CN");
    expect(config.endpoint).toBe("https://api.openai.com/v1");
    expect(config.timeout).toBe(120000);
  });

  it("normalises the engine name and refuses an unknown one", () => {
    expect(core.readConfig((key) => (key === PREF + "engine" ? " AI " : undefined)).engine).toBe("ai");
    expect(() => core.readConfig((key) => (key === PREF + "engine" ? "deepl" : undefined))).toThrow(
      /Unknown engine/
    );
  });

  it("falls back to the default timeout when the pref is nonsense", () => {
    expect(core.readConfig((key) => (key === PREF + "timeout" ? "abc" : undefined)).timeout).toBe(120000);
    expect(core.readConfig((key) => (key === PREF + "timeout" ? 5000 : undefined)).timeout).toBe(5000);
  });
});

describe("legacy pref migration", () => {
  function store(entries) {
    const map = new Map(entries);
    return {
      map,
      hasUserValue: (key) => map.has(key),
      get: (key) => map.get(key),
      set: (key, value) => map.set(key, value),
      clear: (key) => map.delete(key),
    };
  }

  it("copies root-level 0.1.2 prefs into the scoped namespace once", () => {
    const io = store([
      ["dualtran.engine", "ai"],
      ["dualtran.model", "deepseek-chat"],
    ]);
    expect(core.migrateLegacyPrefs(io)).toEqual(["engine", "model"]);
    expect(io.map.get(PREF + "engine")).toBe("ai");
    expect(io.map.has("dualtran.engine")).toBe(false);
    expect(core.migrateLegacyPrefs(io)).toEqual([]);
  });

  it("never overwrites a value the user already set in the scoped namespace", () => {
    const io = store([
      ["dualtran.engine", "ai"],
      [PREF + "engine", "google"],
    ]);
    expect(core.migrateLegacyPrefs(io)).toEqual([]);
    expect(io.map.get(PREF + "engine")).toBe("google");
    expect(io.map.get("dualtran.engine")).toBe("ai");
  });
});

describe("google url", () => {
  it("encodes the query without relying on URLSearchParams", () => {
    expect(core.googleUrl({ text: "a b&c=d 中文", target: "zh-CN" })).toBe(
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=" +
        encodeURIComponent("a b&c=d 中文")
    );
  });
});

describe("chunk limit per engine", () => {
  it("uses a small window for Google and a large one for AI", () => {
    expect(core.chunkLimitFor("google")).toBe(1800);
    expect(core.chunkLimitFor("ai")).toBe(8000);
  });
});

describe("selection", () => {
  const regular = (id) => ({ id, isRegularItem: () => true, parentItemID: false });
  const child = (id, parent) => ({ id, isRegularItem: () => false, parentItemID: parent });

  it("maps a selected PDF to its parent item and drops duplicates", () => {
    const parent = regular(10);
    const out = core.resolveTargets([regular(10), child(11, 10), child(12, 10)], (id) => (id === 10 ? parent : null));
    expect(out.map((item) => item.id)).toEqual([10]);
  });

  it("drops notes and attachments without a parent", () => {
    expect(core.resolveTargets([child(1, false)], () => null)).toEqual([]);
  });
});

describe("selection hint", () => {
  it("explains an empty selection", () => {
    expect(core.selectionHint([])).toMatch(/item list/);
  });

  it("explains that a standalone note is not translated", () => {
    const note = { isRegularItem: () => false, isNote: () => true, parentItemID: false };
    const hint = core.selectionHint([note]);
    expect(hint).toMatch(/standalone note/);
    expect(hint).toMatch(/does not translate note text/);
  });

  it("explains an attachment without a parent record", () => {
    const attachment = { isRegularItem: () => false, isNote: () => false, parentItemID: false };
    expect(core.selectionHint([attachment])).toMatch(/parent record/);
  });

  it("stays quiet when something can be translated", () => {
    expect(core.selectionHint([{ id: 1, isRegularItem: () => true, parentItemID: false }])).toBe(null);
  });

  it("returns stable codes for the UI to localise", () => {
    expect(core.selectionProblem([])).toBe("empty");
    expect(core.selectionProblem([{ isRegularItem: () => false, isNote: () => true, parentItemID: false }])).toBe(
      "standalone-note"
    );
    expect(core.selectionProblem([{ isRegularItem: () => false, isNote: () => false, parentItemID: false }])).toBe(
      "no-parent"
    );
    expect(core.selectionProblem([{ id: 1, isRegularItem: () => true, parentItemID: false }])).toBe(null);
  });
});

describe("annotation building", () => {
  const selection = {
    text: "Attention is all you need",
    pageLabel: "1",
    sortIndex: "00001|000001",
    position: { pageIndex: 0, rects: [[100, 700, 300, 712]] },
  };

  it("builds a highlight annotation with the translation as comment", () => {
    const json = core.buildAnnotation(selection, "注意力就是你所需要的一切", "highlight", { key: "ABCD2345" });
    expect(json.type).toBe("highlight");
    expect(json.text).toBe(selection.text);
    expect(json.comment).toBe("注意力就是你所需要的一切");
    expect(json.key).toBe("ABCD2345");
    expect(json.position).toBe(selection.position);
    expect(json.pageLabel).toBe("1");
  });

  it("builds a sticky note below the last selected line", () => {
    const json = core.buildAnnotation(selection, "译文", "sticky", { key: "ABCD2345" });
    expect(json.type).toBe("note");
    expect(json.text).toBeUndefined();
    expect(json.position.rects).toEqual([[100, 688, 112, 700]]);
    expect(json.position.pageIndex).toBe(0);
  });

  it("uses the reader's key when it provides one", () => {
    const json = core.buildAnnotation({ ...selection, key: "READER01" }, "译文", "highlight", {
      key: "OTHER123",
    });
    expect(json.key).toBe("READER01");
  });

  it("refuses a selection without text or position", () => {
    expect(() => core.buildAnnotation({}, "译文", "highlight", { key: "K" })).toThrow(/no selected text/);
    expect(() => core.buildAnnotation(selection, "", "highlight", { key: "K" })).toThrow(/empty/);
    expect(() =>
      core.buildAnnotation({ text: "x", position: {} }, "译", "sticky", { key: "K" })
    ).toThrow(/no position/);
  });
});

describe("item action payloads", () => {
  const fields = { title: "Attention Is All You Need", abstractText: "We propose the Transformer." };
  const translation = { title: "注意力就是你所需要的一切", abstract: "我们提出了 Transformer。" };

  it("appends a plain-text block and keeps the original abstract", () => {
    const text = core.buildAppendText(fields.abstractText, translation.title, translation.abstract, "zh-CN");
    expect(text.startsWith(fields.abstractText + "\n\n")).toBe(true);
    expect(text).toContain("[DualTran · zh-CN]");
    expect(text).toContain("Title: 注意力就是你所需要的一切");
    expect(text).toContain("我们提出了 Transformer。");
  });

  it("handles an empty abstract when appending", () => {
    const text = core.buildAppendText("", translation.title, "", "zh-CN");
    expect(text.startsWith("[DualTran · zh-CN]")).toBe(true);
    expect(text).toContain("Title: 注意力就是你所需要的一切");
  });

  it("writes a backup note with escaped originals", () => {
    const html = core.buildBackupNote(
      { title: "A <b>title</b>", abstractText: "Abstract & more" },
      "zh-CN",
      "2026-10-29 10:00 UTC"
    );
    expect(html).toContain("A &lt;b&gt;title&lt;/b&gt;");
    expect(html).toContain("Abstract &amp; more");
    expect(html).toContain("2026-10-29 10:00 UTC");
    expect(html).toContain("zh-CN");
  });

  it("builds the fields of a translated copy", () => {
    expect(core.buildTranslatedItemFields(fields, translation, "zh-CN")).toEqual({
      title: "注意力就是你所需要的一切",
      abstractNote: "我们提出了 Transformer。",
      language: "zh-CN",
    });
  });

  it("falls back to the original title when the translation is empty", () => {
    expect(core.buildTranslatedItemFields(fields, { title: "", abstract: "" }, "zh-CN").title).toBe(
      fields.title
    );
  });
});

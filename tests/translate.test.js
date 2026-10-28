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
});

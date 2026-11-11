import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import catalog from "../content/catalog.js";
import languages from "../content/languages.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/models-dev-sample.json"), "utf8"));
const languageNames = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/language-names.json"), "utf8"));

const project = () => catalog.projectCatalog(raw);

describe("projectCatalog", () => {
  it("indexes providers by id and models by provider + model id", () => {
    const result = project();
    expect(Object.keys(result.providers).length).toBe(Object.keys(raw).length);
    expect(result.modelsById.deepseek["deepseek-v4-pro"].text).toBe("DeepSeek V4 Pro");
    expect(result.modelsById.openai["gpt-6-sol"].levels).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("keeps the provider API base and falls back to the built-in default", () => {
    const result = project();
    expect(result.providers.deepseek.api).toBe("https://api.deepseek.com");
    expect(result.providers.openai.api).toBe("");
    expect(catalog.apiForProvider(result.providers, "openai")).toBe("https://api.openai.com/v1");
  });

  it("declares no reasoning levels for a model that does not advertise them", () => {
    const result = project();
    expect(result.modelsById.openai["gpt-4o"].levels).toEqual([]);
  });

  it("reads levels from the effort option, ignoring toggle and budget_tokens", () => {
    const result = project();
    expect(result.modelsById.deepseek["deepseek-flash"].levels).toEqual(["low", "high", "max"]);
  });

  it("keeps only effort values the request path understands, in canonical order", () => {
    const result = project();
    expect(result.modelsById.openai["gpt-realtime-2.1"].levels).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });
});

describe("buildProviderList", () => {
  it("merges built-ins and models.dev into one alphabetical list", () => {
    const list = catalog.buildProviderList(project());
    const compare = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
    const catalogue = list.filter((entry) => entry.source !== "custom").map((entry) => entry.name);
    expect(catalogue.slice().sort(compare.compare)).toEqual(catalogue);
    expect(list.length).toBeGreaterThan(15);
    expect(list.some((entry) => entry.source === "built-in")).toBe(true);
    expect(list.some((entry) => entry.source === "models.dev")).toBe(true);
  });

  it("puts the custom provider last", () => {
    const list = catalog.buildProviderList(project());
    expect(list[list.length - 1]).toMatchObject({ id: "custom", source: "custom" });
  });

  it("folds an alias twin into its built-in instead of listing it twice", () => {
    const list = catalog.buildProviderList(project());
    const ids = list.map((entry) => entry.id);
    expect(ids).toContain("google-gemini");
    expect(ids).not.toContain("google");
    expect(ids).toContain("moonshot");
    expect(ids).not.toContain("moonshotai");
    expect(ids).toContain("xai");
    expect(ids).not.toContain("grok");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives the built-in its models from the dev entry and the catalogue's API", () => {
    const list = catalog.buildProviderList(project());
    const moonshot = list.find((entry) => entry.id === "moonshot");
    expect(moonshot.name).toBe("Moonshot AI");
    expect(moonshot.api).toBe("https://api.moonshot.ai/v1");
    // one row per catalogue model, plus the trailing custom-model row
    expect(moonshot.models.length).toBe(Object.keys(raw.moonshotai.models).length + 1);
  });

  it("lists models sorted by name with the custom model id last", () => {
    const compare = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
    for (const entry of catalog.buildProviderList(project())) {
      const values = entry.models.map((model) => model.value);
      expect(values.some((value) => /^__custom/.test(value))).toBe(true);
      expect(values[values.length - 1]).toBe("__custom__");
      const labels = entry.models
        .filter((model) => !/^__custom/.test(model.value))
        .map((model) => model.text);
      expect(labels.slice().sort(compare.compare), entry.id).toEqual(labels);
    }
  });

  it("still offers a model picker for a provider the catalogue dropped", () => {
    const list = catalog.buildProviderList(catalog.projectCatalog({}));
    const openai = list.find((entry) => entry.id === "openai");
    expect(openai.models.length).toBeGreaterThan(0);
    expect(openai.models[openai.models.length - 1].value).toBe("__custom__");
  });
});

describe("languageOptions", () => {
  it("offers at least 38 human-readable options", () => {
    const options = catalog.languageOptions(languageNames, "zh-CN");
    expect(options.length).toBeGreaterThanOrEqual(38);
  });

  it("labels each option Name (code) and sorts by name", () => {
    const options = catalog.languageOptions(languageNames, "en");
    expect(options[0]).toMatchObject({ value: "af", text: "Afrikaans (af)" });
    const chinese = options.find((option) => option.value === "zh-CN");
    expect(chinese.text).toBe("Chinese (Simplified) (zh-CN)");
    const compare = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
    const texts = options.map((option) => option.text);
    expect(texts.slice().sort(compare.compare)).toEqual(texts);
  });

  it("never offers auto as a target", () => {
    const options = catalog.languageOptions({ ...languageNames, auto: "Detect" }, "en");
    expect(options.some((option) => /^auto$/i.test(option.value))).toBe(false);
  });

  it("keeps the stored language selectable even when the table lacks a name", () => {
    const options = catalog.languageOptions({ en: "English" }, "tlh");
    expect(options.find((option) => option.value === "tlh").text).toBe("tlh (tlh)");
  });

  it("ships one English name per code from the fixture", () => {
    expect(languages.names).toEqual(languageNames);
    expect(languages.forCode("pt-BR")).toBe("Portuguese (Brazil)");
    expect(languages.forCode("zz")).toBe("zz");
  });
});

describe("resolveEndpointOnProviderChange", () => {
  const providers = {
    openai: { api: "https://api.openai.com/v1" },
    deepseek: { api: "https://api.deepseek.com" },
  };

  it("writes the API base of the chosen provider", () => {
    expect(
      catalog.resolveEndpointOnProviderChange({
        current: "https://api.deepseek.com",
        previousProvider: "deepseek",
        nextProvider: "openai",
        providers,
      })
    ).toBe("https://api.openai.com/v1");
  });

  it("never overwrites an endpoint the user typed", () => {
    expect(
      catalog.resolveEndpointOnProviderChange({
        current: "https://proxy.example/v1",
        previousProvider: "openai",
        nextProvider: "deepseek",
        providers,
      })
    ).toBe("https://proxy.example/v1");
  });

  it("accepts the provider's own base as not-yet-edited", () => {
    expect(
      catalog.resolveEndpointOnProviderChange({
        current: "https://api.deepseek.com",
        previousProvider: "deepseek",
        nextProvider: "openai",
        providers,
      })
    ).toBe("https://api.openai.com/v1");
  });

  it("fills an empty endpoint even without a previous provider", () => {
    expect(
      catalog.resolveEndpointOnProviderChange({
        current: "",
        previousProvider: null,
        nextProvider: "openai",
        providers,
      })
    ).toBe("https://api.openai.com/v1");
  });

  it("leaves the endpoint alone when the provider declares no base", () => {
    const onlyOpenai = { openai: { api: "" } };
    expect(
      catalog.resolveEndpointOnProviderChange({
        current: "https://api.openai.com/v1",
        previousProvider: "openai",
        nextProvider: "custom",
        providers: { ...onlyOpenai, custom: { api: "" } },
      })
    ).toBe("https://api.openai.com/v1");
  });
});

describe("resolveReasoningDepth", () => {
  it("persists the lowest sentinel", () => {
    expect(catalog.LOWEST).toBe("lowest");
  });

  it("prefers none, then minimal, then low", () => {
    const resolve = (levels) => catalog.resolveReasoningDepth({ setting: "lowest", levels });
    expect(resolve(["low", "medium", "high"])).toBe("low");
    expect(resolve(["minimal", "low", "high"])).toBe("minimal");
    expect(resolve(["none", "low", "high"])).toBe("none");
    expect(resolve(["none", "minimal", "low"])).toBe("none");
  });

  it("sends no parameter when the model declares nothing usable", () => {
    expect(catalog.resolveReasoningDepth({ setting: "lowest", levels: [] })).toBe("");
    expect(catalog.resolveReasoningDepth({ setting: "lowest" })).toBe("");
  });

  it("honours an explicit depth the model offers", () => {
    expect(catalog.resolveReasoningDepth({ setting: "high", levels: ["low", "high"] })).toBe("high");
  });

  it("falls back to the ladder when the explicit depth is not offered", () => {
    expect(catalog.resolveReasoningDepth({ setting: "max", levels: ["minimal", "low"] })).toBe("minimal");
  });

  it("offers the sentinel plus the model's levels for the picker", () => {
    expect(catalog.reasoningOptions({ setting: "lowest", levels: ["low", "high"] })).toEqual([
      { value: "lowest", level: "" },
      { value: "low", level: "low" },
      { value: "high", level: "high" },
    ]);
  });
});

describe("fixture-wide reasoning invariants", () => {
  it("never resolves to a level the model does not offer", () => {
    const projected = project();
    for (const [provider, models] of Object.entries(projected.modelsById)) {
      for (const [id, model] of Object.entries(models)) {
        const value = catalog.resolveReasoningDepth({ setting: "lowest", levels: model.levels });
        if (value) expect(model.levels, provider + "/" + id).toContain(value);
        else expect(model.levels, provider + "/" + id).toEqual([]);
      }
    }
  });

  it("sends no reasoning parameter for every model that declares nothing", () => {
    const projected = project();
    const silent = projected.modelsById.openai["gpt-4o"];
    expect(catalog.resolveReasoningDepth({ setting: "lowest", levels: silent.levels })).toBe("");
  });
});

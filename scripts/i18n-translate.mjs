#!/usr/bin/env node
/**
 * Fill missing locales from locales/en.json using an OpenAI-compatible endpoint.
 *
 * en, zh_CN and zh_TW are maintained by hand. Every other locale in LOCALES is generated here
 * and checked into the repository, so the build never depends on the network.
 *
 * Usage: node scripts/i18n-translate.mjs [--force] [--only=de,fr]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = resolve(root, "locales");

const LOCALES = {
  af: "Afrikaans",
  ar: "Arabic",
  ca: "Catalan",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  es: "Spanish",
  fa: "Persian",
  fi: "Finnish",
  fr: "French",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  hu: "Hungarian",
  is: "Icelandic",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  lv: "Latvian",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  pt_BR: "Brazilian Portuguese",
  pt_PT: "European Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sl: "Slovenian",
  sr: "Serbian",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  ug: "Uyghur",
  uk: "Ukrainian",
  vi: "Vietnamese",
};

const HANDWRITTEN = new Set(["en", "zh_CN", "zh_TW"]);
const endpoint = process.env.DUALTRAN_I18N_ENDPOINT || "http://127.0.0.1:11434/v1/chat/completions";
const model = process.env.DUALTRAN_I18N_MODEL || "glm-5.3-flash:cloud";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const onlyArg = process.argv.find((value) => value.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;

const english = JSON.parse(readFileSync(resolve(localesDir, "en.json"), "utf8"));

function stripFence(text) {
  return String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

async function translate(language, code) {
  const body = {
    model,
    temperature: 0,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You are a professional software localizer. Translate every JSON value into " +
          language +
          ". Keep the keys unchanged, keep placeholders such as {count}, {current}, {total}, " +
          "{target} and {date} exactly as they are, keep leading/trailing spaces and punctuation " +
          "style natural for the language. Return strict JSON only, with no markdown fences and " +
          "no commentary.",
      },
      { role: "user", content: JSON.stringify(english, null, 2) },
    ],
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((error) => {
    throw new Error("request failed: " + error.message);
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const payload = await response.json();
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message.content;
  if (!content) throw new Error("empty completion");
  const parsed = JSON.parse(stripFence(content));

  const missing = Object.keys(english).filter((key) => typeof parsed[key] !== "string" || !parsed[key].trim());
  if (missing.length) throw new Error("missing keys: " + missing.join(", "));

  const extra = Object.keys(parsed).filter((key) => !(key in english));
  for (const key of extra) delete parsed[key];

  return parsed;
}

const codes = Object.keys(LOCALES).filter((code) => !only || only.has(code));
let done = 0;
for (const code of codes) {
  const file = resolve(localesDir, code + ".json");
  if (existsSync(file) && !force) continue;

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const dict = await translate(LOCALES[code], code);
      writeFileSync(file, JSON.stringify(dict, null, 2) + "\n");
      console.log(code + ": ok (" + attempt + ")");
      done += 1;
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
    }
  }
  if (lastError) {
    console.error(code + ": FAILED " + lastError.message);
    process.exitCode = 1;
  }
}

console.log("generated " + done + " locale(s)");

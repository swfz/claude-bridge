import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCssColor,
  isDarkColor,
  effectiveBackground,
  resolveInjectedScheme,
} from "../client/src/utils/previewColorScheme.js";

describe("parseCssColor", () => {
  it("rgb() をパースする", () => {
    assert.deepEqual(parseCssColor("rgb(26, 26, 46)"), { r: 26, g: 26, b: 46, a: 1 });
  });

  it("rgba() のアルファを読む", () => {
    assert.deepEqual(parseCssColor("rgba(0, 0, 0, 0)"), { r: 0, g: 0, b: 0, a: 0 });
    assert.deepEqual(parseCssColor("rgba(255, 255, 255, 0.5)"), { r: 255, g: 255, b: 255, a: 0.5 });
  });

  it("スペース区切り + / アルファの新記法もパースする", () => {
    assert.deepEqual(parseCssColor("rgb(10 20 30 / 50%)"), { r: 10, g: 20, b: 30, a: 0.5 });
  });

  it("不正な文字列は null", () => {
    assert.equal(parseCssColor(""), null);
    assert.equal(parseCssColor(undefined), null);
    assert.equal(parseCssColor("transparent"), null);
  });
});

describe("isDarkColor", () => {
  it("暗色を判定する", () => {
    assert.equal(isDarkColor({ r: 26, g: 26, b: 46 }), true);
    assert.equal(isDarkColor({ r: 0, g: 0, b: 0 }), true);
  });

  it("明色を判定する", () => {
    assert.equal(isDarkColor({ r: 255, g: 255, b: 255 }), false);
    assert.equal(isDarkColor({ r: 246, g: 248, b: 250 }), false);
  });
});

describe("effectiveBackground", () => {
  it("body の不透明背景を優先する", () => {
    const bg = effectiveBackground("rgb(26, 26, 46)", "rgb(255, 255, 255)");
    assert.deepEqual(bg, { r: 26, g: 26, b: 46, a: 1 });
  });

  it("body が透過なら html を見る", () => {
    const bg = effectiveBackground("rgba(0, 0, 0, 0)", "rgb(255, 255, 255)");
    assert.deepEqual(bg, { r: 255, g: 255, b: 255, a: 1 });
  });

  it("どちらもほぼ透過なら null", () => {
    assert.equal(effectiveBackground("rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.2)"), null);
  });
});

describe("resolveInjectedScheme", () => {
  it("ページ自身が color-scheme を宣言していれば触らない", () => {
    const scheme = resolveInjectedScheme({
      declared: "dark",
      ownInjected: null,
      bodyBg: "rgb(26, 26, 46)",
      htmlBg: "rgba(0, 0, 0, 0)",
      previewScheme: "dark",
    });
    assert.equal(scheme, null);
  });

  it("自分が注入した宣言は再判定できる", () => {
    const scheme = resolveInjectedScheme({
      declared: "dark",
      ownInjected: "dark",
      bodyBg: "rgb(255, 255, 255)",
      htmlBg: "rgba(0, 0, 0, 0)",
      previewScheme: "dark",
    });
    assert.equal(scheme, "light");
  });

  it("ダーク背景だけ指定したページ → dark（黒文字が UA 既定で明るくなる）", () => {
    const scheme = resolveInjectedScheme({
      declared: "normal",
      ownInjected: null,
      bodyBg: "rgb(26, 26, 46)",
      htmlBg: "rgba(0, 0, 0, 0)",
      previewScheme: "light",
    });
    assert.equal(scheme, "dark");
  });

  it("白背景を明示したページ → light（文字は黒のまま守られる）", () => {
    const scheme = resolveInjectedScheme({
      declared: "normal",
      ownInjected: null,
      bodyBg: "rgb(255, 255, 255)",
      htmlBg: "rgba(0, 0, 0, 0)",
      previewScheme: "dark",
    });
    assert.equal(scheme, "light");
  });

  it("背景が透過ならプレビュー側の明暗に従う", () => {
    const base = {
      declared: "normal",
      ownInjected: null,
      bodyBg: "rgba(0, 0, 0, 0)",
      htmlBg: "rgba(0, 0, 0, 0)",
    };
    assert.equal(resolveInjectedScheme({ ...base, previewScheme: "dark" }), "dark");
    assert.equal(resolveInjectedScheme({ ...base, previewScheme: "light" }), "light");
  });

  it("computed が空でも previewScheme に落ちる", () => {
    const scheme = resolveInjectedScheme({
      declared: "",
      ownInjected: null,
      bodyBg: "",
      htmlBg: "",
      previewScheme: "dark",
    });
    assert.equal(scheme, "dark");
  });
});

// 在 node 裡跑 public/i18n/i18n.js（假的瀏覽器環境），拿到 aigileI18n：檢查伺服器回的訊息在英文介面整句翻得出來
// 用法：const en = loadI18n('en'); en.err(code, message)（網頁顯示錯誤時用的同一支）；onlyEnglish(text) 檢查沒有中文或全形標點
import fs from 'node:fs';
import { loadEn } from './i18n-scan.js';

export function loadI18n(lang) {
  const src = fs.readFileSync(new URL('../public/i18n/i18n.js', import.meta.url), 'utf8');
  const script = {}, win = {};
  const doc = { documentElement: { lang: '', classList: { add() {}, remove() {} } }, addEventListener() {}, createElement: () => script, head: { append() {}, querySelector: () => null }, body: null };
  new Function('window', 'document', 'localStorage', 'navigator', 'location', 'MutationObserver', src)(
    win, doc, { getItem: () => lang, setItem() {} }, { language: 'zh-TW' }, { reload() {} }, class { observe() {} });
  if (lang === 'en') { win.AIGILE_EN = loadEn(); script.onload(); }
  return win.aigileI18n;
}
// 中文字或全形標點
export const HAN_OR_FULLWIDTH = /[㐀-鿿]|[：（）「」；，、。]/;

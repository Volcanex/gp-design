/**
 * Inline Phosphor icons. The SVG text lives in the generated icons-data.ts
 * (scripts/gen-icons.mjs), so the bundle carries exactly the glyphs named
 * there and nothing else; the old icon webfont (and its preload) is gone.
 * `icon(name)` for lit templates, `iconHtml(name)`/`iconElement(name)` for
 * the few places that build DOM by hand. Adding an icon is one entry in
 * the script's NAMES list; the IconName type keeps call sites honest.
 */

import { html, type TemplateResult } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { ICON_SVG } from './icons-data';

export type IconName = keyof typeof ICON_SVG;

export function iconHtml(name: IconName): string {
  return ICON_SVG[name];
}

export function icon(name: IconName): TemplateResult {
  return html`${unsafeHTML(ICON_SVG[name])}`;
}

/** For imperative DOM: a detached <svg> element. */
export function iconElement(name: IconName): SVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = ICON_SVG[name];
  return tpl.content.firstElementChild as SVGElement;
}

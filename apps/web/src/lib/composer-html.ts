import DOMPurify from 'dompurify';

export const maxMessageLength = 1048576;
const allowedTags = ['p','div','span','br','strong','b','em','i','u','s','strike','del','a','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','pre','code','hr','table','thead','tbody','tfoot','tr','td','th','colgroup','col','img','sub','sup'];
const styleProperties = new Set(['color','background-color','font-family','font-size','font-weight','font-style','text-decoration','text-decoration-line','text-align','line-height','white-space','vertical-align','margin','margin-top','margin-bottom','margin-left','margin-right','padding','padding-top','padding-bottom','padding-left','padding-right','border','border-top','border-bottom','border-left','border-right','border-color','border-style','border-width','border-collapse','width','height','max-width','list-style-type']);

export function safeStyles(style: CSSStyleDeclaration): string {
  return Array.from(style).filter(property => styleProperties.has(property)).map(property => {
    const value = style.getPropertyValue(property);
    return /url\s*\(|expression\s*\(|var\s*\(|[<>\\]/i.test(value) ? '' : `${property}:${value}`;
  }).filter(Boolean).join(';');
}

export function safeComposerUrl(value: string, image = false): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return (image ? ['https:','http:'] : ['https:','http:','mailto:','tel:']).includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** Resolve clipboard class styles before removing Office/Docs wrappers and unsafe markup. */
export function cleanComposerHtml(html: string, imageSources:readonly string[] = []): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const wordLists = new Map(Array.from(doc.body.querySelectorAll<HTMLElement>('p')).filter(element => /mso-list\s*:/i.test(element.getAttribute('style') || '')).map(element => [element, element.querySelector<HTMLElement>('[style*="mso-list:Ignore"],[style*="mso-list: Ignore"]')]));
  // Clipboard stylesheets stay in an inert document and are never added to the page.
  const originalStyles = new Map(Array.from(doc.body.querySelectorAll<HTMLElement>('*'), element => [element, element.getAttribute('style') || '']));
  for (const style of Array.from(doc.querySelectorAll('style')).slice(0, 12)) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(style.textContent || '');
      for (const rule of Array.from(sheet.cssRules).slice(0, 500)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        const cleaned = safeStyles(rule.style);
        if (!cleaned) continue;
        try { for (const element of Array.from(doc.body.querySelectorAll<HTMLElement>(rule.selectorText)).slice(0, 5000)) element.style.cssText += `;${cleaned}`; } catch { /* Ignore selectors that are invalid outside the source document. */ }
      }
    } catch { /* Inline formatting remains available if a clipboard stylesheet is malformed. */ }
  }
  for (const [element, original] of originalStyles) element.style.cssText += `;${original}`;
  // Old HTML editors still use <font>; translate it into the same inline styles.
  for (const font of doc.body.querySelectorAll('font')) {
    const span = doc.createElement('span');
    span.style.cssText = font.getAttribute('style') || '';
    if (font.getAttribute('color')) span.style.color = font.getAttribute('color')!;
    if (font.getAttribute('face')) span.style.fontFamily = font.getAttribute('face')!;
    const size = Number(font.getAttribute('size'));
    if (size >= 1 && size <= 7) span.style.fontSize = `${[10,13,16,18,24,32,48][size - 1]}px`;
    span.append(...Array.from(font.childNodes)); font.replaceWith(span);
  }
  // Word represents lists as indented paragraphs with an mso-list style.
  let list: HTMLOListElement | HTMLUListElement | null = null;
  for (const paragraph of Array.from(doc.body.querySelectorAll<HTMLElement>('p'))) {
    if (!wordLists.has(paragraph)) { list = null; continue; }
    const marker = wordLists.get(paragraph);
    const text = marker?.textContent || paragraph.textContent || '';
    const ordered = /^\s*(?:\d+[.)]|[a-z][.)])/i.test(text);
    if (!list || list.nextElementSibling !== paragraph || list.tagName !== (ordered ? 'OL' : 'UL')) {
      list = doc.createElement(ordered ? 'ol' : 'ul'); paragraph.before(list);
    }
    if (marker) marker.remove();
    else if (paragraph.firstChild?.nodeType === Node.TEXT_NODE) paragraph.firstChild.textContent = paragraph.firstChild.textContent?.replace(/^\s*(?:[•·\u00b7\u25cf]|\d+[.)]|[a-z][.)])\s*/, '') || '';
    const item = doc.createElement('li'); item.append(...Array.from(paragraph.childNodes)); list.append(item); paragraph.remove();
  }
  // Treat inherited block typography as actual email content, not editor chrome.
  for (const element of doc.body.querySelectorAll<HTMLElement>('[role="heading"]')) {
    if (/^\d$/.test(element.getAttribute('aria-level') || '')) {
      const heading = doc.createElement(`h${Math.min(6, Math.max(1, Number(element.getAttribute('aria-level'))))}`);
      heading.style.cssText = element.style.cssText; heading.append(...Array.from(element.childNodes)); element.replaceWith(heading);
    }
  }
  for (const element of doc.body.querySelectorAll<HTMLElement>('*')) {
    if (element.tagName === 'A') {
      const href = safeComposerUrl(element.getAttribute('href') || '');
      if (href) { element.setAttribute('href',href); element.setAttribute('rel','noopener noreferrer'); element.setAttribute('target','_blank'); }
      else element.removeAttribute('href');
    }
    if (element.tagName === 'IMG') {
      const rawSrc = element.getAttribute('src') || '';
      const src = imageSources.includes(rawSrc) ? rawSrc : safeComposerUrl(rawSrc, true);
      if (!src) { element.replaceWith(doc.createTextNode(element.getAttribute('alt') || '')); continue; }
      element.setAttribute('src',src); element.setAttribute('referrerpolicy','no-referrer');
    }
    const cleaned = safeStyles(element.style);
    if (cleaned) element.setAttribute('style',cleaned); else element.removeAttribute('style');
  }
  // Inline block font styles on spans too, so changing paragraph types preserves them.
  for (const element of doc.body.querySelectorAll<HTMLElement>('p,div,td,th,h1,h2,h3,h4,h5,h6,li')) {
    const spanStyle = ['font-family','font-size','color','background-color','line-height'].map(property => element.style.getPropertyValue(property) ? `${property}:${element.style.getPropertyValue(property)}` : '').filter(Boolean).join(';');
    if (!spanStyle) continue;
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE && /^(P|DIV|TABLE|UL|OL|LI|H[1-6])$/.test((node as Element).tagName)) continue;
      const span = doc.createElement('span'); span.setAttribute('style',spanStyle); node.before(span); span.append(node);
    }
  }
  return DOMPurify.sanitize(doc.body.innerHTML, {
    ALLOWED_TAGS:allowedTags,
    ALLOWED_ATTR:['style','href','target','rel','src','alt','title','width','height','colspan','rowspan','colwidth','start','align','referrerpolicy'],
    ALLOW_DATA_ATTR:false,
    ALLOWED_URI_REGEXP:/^(?:(?:https?|mailto|tel|blob|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    FORBID_TAGS:['style','script','iframe','object','embed','form','input','button','link','meta','svg','math'],
  });
}

export function plainTextFromComposerHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  function text(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (!(node instanceof Element)) return '';
    const content = Array.from(node.childNodes).map(text).join('');
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
    if (node.tagName === 'LI') {
      const parent = node.parentElement;
      const marker = parent?.tagName === 'OL' ? `${Array.from(parent.children).indexOf(node) + Number(parent.getAttribute('start') || 1)}.` : '•';
      return `${marker} ${content.trim()}\n`;
    }
    if (node.tagName === 'TD' || node.tagName === 'TH') return `${content.trim()}\t`;
    if (node.tagName === 'TR') return `${content.trimEnd()}\n`;
    if (/^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE|PRE|TABLE)$/.test(node.tagName)) return `${content.trimEnd()}\n\n`;
    if (node.tagName === 'A' && node.getAttribute('href') && content !== node.getAttribute('href')) return `${content} (${node.getAttribute('href')})`;
    return content;
  }
  return Array.from(doc.body.childNodes).map(text).join('').replace(/\n{3,}/g,'\n\n').trim();
}

/** Inline email defaults keep lists, headings and table borders after delivery. */
export function emailHtmlFromEditor(html: string, imageSources:readonly string[] = []): string {
  const doc = new DOMParser().parseFromString(cleanComposerHtml(html,imageSources),'text/html');
  const defaults: Record<string,string> = {
    p:'margin:0 0 12px', h1:'font-size:28px;line-height:1.3;margin:18px 0 12px',h2:'font-size:23px;line-height:1.35;margin:16px 0 10px',h3:'font-size:19px;line-height:1.4;margin:14px 0 8px',
    ul:'list-style-type:disc;padding-left:24px;margin:10px 0',ol:'list-style-type:decimal;padding-left:24px;margin:10px 0',li:'margin:4px 0',
    table:'border-collapse:collapse;max-width:100%;margin:14px 0',td:'border:1px solid #d9dce5;padding:9px 12px;vertical-align:top',th:'border:1px solid #d9dce5;padding:9px 12px;background-color:#f4f5f8;font-weight:bold;text-align:left',
    blockquote:'border-left:3px solid #d9dce5;margin:12px 0;padding-left:16px;color:#606779',a:'color:#6047c6;text-decoration:underline',img:'max-width:100%;height:auto',
    pre:'white-space:pre-wrap;background-color:#f4f5f8;padding:12px;border-radius:6px',hr:'border:0;border-top:1px solid #d9dce5;margin:18px 0',
  };
  for (const element of doc.body.querySelectorAll<HTMLElement>('*')) if (defaults[element.tagName.toLowerCase()]) element.setAttribute('style',`${defaults[element.tagName.toLowerCase()]};${element.getAttribute('style') || ''}`);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#263345;overflow-wrap:anywhere">${doc.body.innerHTML}</div>`;
}

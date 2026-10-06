import sanitizeHtml from 'sanitize-html';

const allowedTags = [...sanitizeHtml.defaults.allowedTags, 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th'];

export function normalizedCid(value: string | null): string | null {
  const normalized = value?.trim().replace(/^cid:/i, '').replace(/^<|>$/g, '').trim().toLowerCase();
  return normalized && /^[a-z0-9._@-]{1,200}$/.test(normalized) ? normalized : null;
}

export function safePreview(text: string | null, html: string | null): string {
  const plain = text ?? (html ? sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'discard' }) : '');
  return plain.replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function safeForwardText(html: string | null): string | null {
  if (!html) return null;
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'discard' }).replace(/\s+/g, ' ').trim().slice(0, 100000);
}

export function safeEmailHtml(source: string, loadRemoteImages: boolean, cidImages: Record<string, string> = {}): { html: string; hasRemoteImages: boolean } {
  let hasRemoteImages = false;
  const html = sanitizeHtml(source, {
    allowedTags,
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan', 'align'], th: ['colspan', 'rowspan', 'align'],
      table: ['width', 'align'], p: ['align'], div: ['align'],
    },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowedSchemesByTag: { img: ['https', 'http'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      img: (_tag, attributes) => {
        if (/^cid:/i.test(attributes.src ?? '')) {
          const cid = normalizedCid(attributes.src ?? null);
          const resolved = cid ? cidImages[cid] : null;
          return resolved ? { tagName: 'img', attribs: { ...attributes, src: resolved } } : { tagName: 'span', attribs: {}, text: '[Inline image unavailable]' };
        }
        const remote = /^https?:\/\//i.test(attributes.src ?? '');
        if (remote) hasRemoteImages = true;
        if (!remote || !loadRemoteImages) return { tagName: 'span', attribs: {}, text: attributes.alt ? `[Image: ${attributes.alt.slice(0, 120)}]` : '[Image blocked]' };
        return { tagName: 'img', attribs: attributes };
      },
    },
  });
  return { html, hasRemoteImages };
}

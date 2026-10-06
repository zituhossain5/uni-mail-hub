import sanitizeHtml from 'sanitize-html';

const allowedTags = [...sanitizeHtml.defaults.allowedTags, 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th'];

export function safePreview(text: string | null, html: string | null): string {
  const plain = text ?? (html ? sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'discard' }) : '');
  return plain.replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function safeEmailHtml(source: string, loadRemoteImages: boolean): { html: string; hasRemoteImages: boolean } {
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
        const remote = /^https?:\/\//i.test(attributes.src ?? '');
        if (remote) hasRemoteImages = true;
        if (!remote || !loadRemoteImages) return { tagName: 'span', attribs: {}, text: attributes.alt ? `[Image: ${attributes.alt.slice(0, 120)}]` : '[Image blocked]' };
        return { tagName: 'img', attribs: attributes };
      },
    },
  });
  return { html, hasRemoteImages };
}

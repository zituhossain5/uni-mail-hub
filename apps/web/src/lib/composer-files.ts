import { mailAttachmentLimits, type OutgoingAttachmentInput } from '@uni/shared';

export type ComposerFile = { id:string; file:File; url:string; inline:boolean; contentId:string };
export const inlineImageType = (type:string) => /^image\/(png|jpeg|gif|webp)$/i.test(type);
export function fileSize(bytes:number) { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
export function usedComposerFiles(files:ComposerFile[],html:string) { return files.filter(file => !file.inline || html.includes(file.url) || html.includes(`cid:${file.contentId}`)); }
export function replaceImageSources(html:string,files:ComposerFile[],direction:'cid'|'preview') {
  const doc = new DOMParser().parseFromString(html,'text/html');
  for (const img of doc.querySelectorAll('img')) {
    const file = files.find(file => (direction === 'cid' ? file.url : `cid:${file.contentId}`) === img.getAttribute('src'));
    if (file) img.setAttribute('src',direction === 'cid' ? `cid:${file.contentId}` : file.url);
  }
  return doc.body.innerHTML;
}
export function dataImageFile(source:string):File {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/\s]+=*)$/i.exec(source);
  if (!match || match[2]!.length > Math.ceil(mailAttachmentLimits.fileBytes / 3) * 4 + 1024) throw new Error('Paste a PNG, JPEG, GIF or WebP image under 10 MB.');
  const raw = atob(match[2]!.replace(/\s/g,''));
  return new File([Uint8Array.from(raw,char => char.charCodeAt(0))],`pasted-image.${match[1]!.split('/')[1]}`,{ type:match[1]! });
}
export async function encodeComposerFiles(files:ComposerFile[]):Promise<OutgoingAttachmentInput[]> {
  return Promise.all(files.map(async item => {
    const contentBase64 = await new Promise<string>((resolve,reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${item.file.name}. Try adding it again.`));
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(item.file);
    });
    return { filename:item.file.name, contentType:item.file.type || 'application/octet-stream', contentBase64, disposition:item.inline ? 'inline' : 'attachment', ...(item.inline ? { contentId:item.contentId } : {}) };
  }));
}

/** A local MIME download lets dev review attachments while the live API is older. */
export function composerTestMime(input:{ from:string; to:{email:string}[]; cc:{email:string}[]; bcc?:{email:string}[]; subject:string; replyTo?:{email:string}; text:string; html:string; attachments:OutgoingAttachmentInput[] },boundary:string) {
  const b64 = (value:string) => btoa(Array.from(new TextEncoder().encode(value),byte => String.fromCharCode(byte)).join(''));
  const fold = (value:string) => value.match(/.{1,76}/g)?.join('\r\n') || '';
  const encodedHeader = (value:string) => Array.from(value).reduce<string[]>((chunks,char) => { if (!chunks.length || new TextEncoder().encode(chunks.at(-1)! + char).length > 36) chunks.push(char); else chunks[chunks.length - 1] += char; return chunks; },[]).map(part => `=?UTF-8?B?${b64(part)}?=`).join('\r\n ');
  const part = (type:string,body:string) => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${fold(b64(body))}\r\n`;
  const filePart = (file:OutgoingAttachmentInput) => `Content-Type: ${file.contentType}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: ${file.disposition}; filename*=utf-8''${encodeURIComponent(file.filename).replace(/['()*]/g,char => `%${char.charCodeAt(0).toString(16)}`)}\r\n${file.contentId ? `Content-ID: <${file.contentId}>\r\n` : ''}\r\n${fold(file.contentBase64)}\r\n`;
  const alternative = `${boundary}-alt`, related = `${boundary}-related`;
  return [`From: ${input.from}`,`To: ${input.to.map(item => item.email).join(', ')}`,...(input.cc.length ? [`Cc: ${input.cc.map(item => item.email).join(', ')}`] : []),...(input.replyTo ? [`Reply-To: ${input.replyTo.email}`] : []),...(input.bcc?.length ? [`Bcc: ${input.bcc.map(item => item.email).join(', ')}`] : []),`Subject: ${encodedHeader(input.subject)}`,'X-Unsent: 1','MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`,'',
    `--${boundary}`,`Content-Type: multipart/related; boundary="${related}"`,'',`--${related}`,`Content-Type: multipart/alternative; boundary="${alternative}"`,'',`--${alternative}`,part('text/plain',input.text),`--${alternative}`,part('text/html',input.html),`--${alternative}--`,
    ...input.attachments.filter(file => file.disposition === 'inline').flatMap(file => [`--${related}`,filePart(file)]),`--${related}--`,
    ...input.attachments.filter(file => file.disposition === 'attachment').flatMap(file => [`--${boundary}`,filePart(file)]),`--${boundary}--`,''].join('\r\n');
}

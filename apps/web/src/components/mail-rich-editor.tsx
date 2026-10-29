'use client';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Extension, type Editor } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextStyleKit } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { DOMParser as ProseMirrorDOMParser, Fragment, Slice } from '@tiptap/pm/model';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Code2, Eraser, Eye, Highlighter, ImagePlus, IndentDecrease, IndentIncrease, Italic, Link2, List, ListOrdered, Minus, PenLine, Quote, Redo2, Strikethrough, Table2, Underline, Undo2, Unlink, X } from 'lucide-react';
import { dataImageFile, encodeComposerFiles, inlineImageType, replaceImageSources, usedComposerFiles, type ComposerFile } from '@/lib/composer-files';
import type { LucideIcon } from 'lucide-react';
import { cleanComposerHtml, emailHtmlFromEditor, maxMessageLength, plainTextFromComposerHtml, safeComposerUrl, safeStyles } from '@/lib/composer-html';

export type ComposerValue = { html: string; text: string; empty: boolean };
export type MailEditorHandle = { getValue: () => ComposerValue; insertImages:(files:ComposerFile[]) => void; removeImage:(url:string) => void };

const PastedFormatting = Extension.create({
  name:'pastedFormatting',
  addGlobalAttributes() {
    return [{ types:['paragraph','heading','blockquote','bulletList','orderedList','listItem','table','tableCell','tableHeader','image'], attributes:{
      pastedStyle:{ default:null, parseHTML:(element: HTMLElement) => safeStyles(element.style) || null, renderHTML:attributes => attributes.pastedStyle ? { style:attributes.pastedStyle } : {} },
    } }];
  },
});
const fonts = ['Arial','Calibri','Verdana','Georgia','Times New Roman','Courier New'];
const sizes = ['10px','12px','14px','16px','18px','20px','24px','28px','32px','36px','48px'];

function Tool({ icon:Icon, label, active, disabled, action }: { icon:LucideIcon; label:string; active?:boolean; disabled?:boolean; action:() => void }) {
  return <button type="button" className="mail-editor-tool" title={label} aria-label={label} aria-pressed={active === undefined ? undefined : active} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={action}><Icon size={16} strokeWidth={1.8} aria-hidden="true"/></button>;
}

export function MailRichEditor({ editorRef, initialContent = '', disabled = false, onChange, onReady, getFiles, onFiles }: { editorRef:Ref<MailEditorHandle>; initialContent?:string; disabled?:boolean; onChange:(value:ComposerValue) => void; onReady:() => void; getFiles:() => ComposerFile[]; onFiles:(files:File[],inline:boolean) => ComposerFile[] }) {
  const [mode,setMode] = useState<'write'|'html'|'preview'>('write');
  const [source,setSource] = useState('');
  const [previewState,setPreviewState] = useState({ source:'',html:'' });
  const [plainPaste,setPlainPaste] = useState(false);
  const plainPasteRef = useRef(false);
  const [notice,setNotice] = useState('');
  const [insert,setInsert] = useState<'link'|'image'|'table'|null>(null);
  const [url,setUrl] = useState('');
  const [alternative,setAlternative] = useState('');
  const [rows,setRows] = useState(3);
  const [columns,setColumns] = useState(3);
  const [startingContent] = useState(() => initialContent ? cleanComposerHtml(replaceImageSources(initialContent,getFiles(),'preview'),getFiles().map(file => file.url)) : '');
  function changed(current: Editor) { onChange({ html:current.getHTML(), text:current.getText(), empty:current.isEmpty }); }
  const editor = useEditor({
    immediatelyRender:false,
    shouldRerenderOnTransaction:false,
    extensions:[
      StarterKit.configure({ heading:{ levels:[1,2,3] }, link:{ openOnClick:false, HTMLAttributes:{ rel:'noopener noreferrer', target:'_blank' } } }),
      TextStyleKit, TextAlign.configure({ types:['heading','paragraph'] }),
      TableKit.configure({ table:{ resizable:false } }),
      Image.configure({ inline:true, allowBase64:false, HTMLAttributes:{ referrerpolicy:'no-referrer' } }),
      Placeholder.configure({ placeholder:'Write your message, or paste formatted content here…' }), PastedFormatting,
    ],
    content:startingContent,
    editorProps:{
      attributes:{ role:'textbox', 'aria-label':'Message body', 'aria-multiline':'true', 'data-testid':'mail-message-editor', spellcheck:'true' },
      transformPastedHTML:html => html.length <= maxMessageLength ? cleanComposerHtml(html,getFiles().map(file => file.url)) : '',
      handlePaste(view,event) {
        const html = event.clipboardData?.getData('text/html') || '';
        const text = event.clipboardData?.getData('text/plain') || '';
        if (html.length > 30 * 1024 * 1024 || text.length > maxMessageLength) { setNotice('This paste is too large. Paste a smaller section.'); return true; }
        if (plainPasteRef.current && (text || html)) {
          const plain = text || plainTextFromComposerHtml(cleanComposerHtml(html));
          const blocks = plain.replace(/\r\n?/g,'\n').split('\n').map(line => view.state.schema.nodes.paragraph!.create(null,line ? view.state.schema.text(line) : null));
          view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(blocks),1,1)).scrollIntoView());
          setNotice('Pasted as plain text.'); return true;
        }
        const clipboardFiles = Array.from(event.clipboardData?.files || []);
        if (clipboardFiles.length || /<img[^>]+src=["']data:/i.test(html)) {
          if (!view.editable) return true;
          try {
            const doc = new DOMParser().parseFromString(html || '<p></p>','text/html');
            const imageFiles = clipboardFiles.filter(file => inlineImageType(file.type));
            const otherFiles = clipboardFiles.filter(file => !inlineImageType(file.type));
            const images = Array.from(doc.querySelectorAll('img'));
            const placements: { element:HTMLImageElement | null; file:File }[] = [];
            for (const image of images) {
              const src = image.getAttribute('src') || '';
              if (/^(data:|file:|blob:|cid:)/i.test(src) && !getFiles().some(file => file.url === src)) {
                const file = imageFiles.shift() || (/^data:/i.test(src) ? dataImageFile(src) : undefined);
                if (file) placements.push({ element:image,file }); else image.remove();
              }
            }
            for (const file of imageFiles) placements.push({ element:null,file });
            const assets = onFiles([...placements.map(item => item.file),...otherFiles],true);
            placements.forEach((placement,index) => {
              const image = placement.element || doc.createElement('img');
              image.setAttribute('src',assets[index]!.url); image.setAttribute('alt',placement.file.name);
              if (!placement.element) doc.body.append(image);
            });
            if (!html && text) doc.body.prepend(doc.createTextNode(text));
            const cleaned = cleanComposerHtml(doc.body.innerHTML,getFiles().map(file => file.url));
            if (cleaned.length > maxMessageLength) throw new Error('The formatted text is too large. Paste a smaller section.');
            const container = document.createElement('div'); container.innerHTML=cleaned;
            view.dispatch(view.state.tr.replaceSelection(ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(container)).setMeta('paste',true).scrollIntoView());
            setNotice('Added pasted images and files. Your formatting is retained.');
          } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to paste these files.'); }
          return true;
        }
        if (html.length > maxMessageLength) { setNotice('This paste is too large. Paste a smaller section.'); return true; }
        setNotice(html ? 'Pasted with formatting. You can undo with Ctrl/Cmd + Z.' : 'Pasted text.');
        return false;
      },
      handleDrop(view,event) {
        if (!event.dataTransfer?.files.length) return false;
        if (!view.editable) return true;
        try {
          const files = onFiles(Array.from(event.dataTransfer.files),true);
          const nodes = files.filter(file => file.inline).map(file => view.state.schema.nodes.image!.create({ src:file.url,alt:file.file.name }));
          if (nodes.length) {
            const position = view.posAtCoords({ left:event.clientX,top:event.clientY })?.pos ?? view.state.selection.from;
            view.dispatch(view.state.tr.insert(position,Fragment.fromArray(nodes)).scrollIntoView());
          }
          setNotice('Added dropped images and files.');
        } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to add these files.'); }
        return true;
      },
    },
    onCreate:({ editor:current }) => { changed(current); onReady(); },
    onUpdate:({ editor:current }) => changed(current),
  });
  useEffect(() => { editor?.setEditable(!disabled); },[editor,disabled]);
  const ui = useEditorState({ editor, selector:({ editor:current }) => current ? {
    bold:current.isActive('bold'), italic:current.isActive('italic'), underline:current.isActive('underline'), strike:current.isActive('strike'),
    bullet:current.isActive('bulletList'), numbered:current.isActive('orderedList'), quote:current.isActive('blockquote'), link:current.isActive('link'), table:current.isActive('table'),
    alignment:current.getAttributes('paragraph').textAlign || current.getAttributes('heading').textAlign || 'left',
    heading:current.isActive('heading') ? String(current.getAttributes('heading').level) : 'paragraph',
    font:current.getAttributes('textStyle').fontFamily || 'Arial', size:current.getAttributes('textStyle').fontSize || '14px',
    undo:current.can().undo(), redo:current.can().redo(),
  } : null });
  function value(): ComposerValue {
    const raw = mode === 'html' ? source : editor?.getHTML() || '';
    const files = getFiles();
    const cleaned = cleanComposerHtml(replaceImageSources(raw,files,'preview'),files.map(file => file.url));
    const text = plainTextFromComposerHtml(cleaned);
    return { html:replaceImageSources(emailHtmlFromEditor(cleaned,files.map(file => file.url)),files,'cid'), text, empty:!text.trim() && !/<img\b[^>]*\bsrc=/i.test(cleaned) };
  }
  useImperativeHandle(editorRef,() => ({ getValue:value,
    insertImages(files) {
      if (!editor) return;
      if (mode === 'html') editor.commands.setContent(cleanComposerHtml(replaceImageSources(source,getFiles(),'preview'),getFiles().map(file => file.url)));
      setMode('write');
      editor.chain().focus().insertContent(files.filter(file => file.inline).map(file => ({ type:'image',attrs:{ src:file.url,alt:file.file.name } }))).run();
    },
    removeImage(url) {
      if (!editor) return;
      if (mode === 'html') { const doc = new DOMParser().parseFromString(source,'text/html'); for (const img of doc.querySelectorAll('img')) if (img.getAttribute('src') === url || getFiles().some(file => file.url === url && `cid:${file.contentId}` === img.getAttribute('src'))) img.remove(); setSource(doc.body.innerHTML); onChange({ html:doc.body.innerHTML,text:plainTextFromComposerHtml(doc.body.innerHTML),empty:!doc.body.textContent?.trim() && !doc.body.querySelector('img') }); return; }
      const transaction = editor.state.tr;
      editor.state.doc.descendants((node,position) => { if (node.type.name === 'image' && node.attrs.src === url) transaction.delete(transaction.mapping.map(position),transaction.mapping.map(position + node.nodeSize)); });
      editor.view.dispatch(transaction);
    },
  }));
  function switchMode(next: typeof mode) {
    if (mode === 'html' && editor) {
      if (source.length > maxMessageLength) { setNotice('HTML exceeds the 1 MB message limit. Shorten it before switching views.'); return; }
      editor.commands.setContent(cleanComposerHtml(replaceImageSources(source,getFiles(),'preview'),getFiles().map(file => file.url)));
    }
    if (next === 'html') setSource(editor?.getHTML() || '');
    setMode(next); setInsert(null);
  }
  function openInsert(kind: typeof insert) { setInsert(insert === kind ? null : kind); setUrl(kind === 'link' ? String(editor?.getAttributes('link').href || '') : ''); setAlternative(''); setNotice(''); }
  function applyInsert() {
    if (!editor) return;
    if (insert === 'table') editor.chain().focus().insertTable({ rows, cols:columns, withHeaderRow:true }).run();
    else {
      const valid = safeComposerUrl(url,insert === 'image');
      if (!valid) { setNotice(insert === 'image' ? 'Enter a full http:// or https:// image URL.' : 'Enter a full https://, http://, mailto:, or tel: link.'); return; }
      if (insert === 'image') editor.chain().focus().setImage({ src:valid, alt:alternative }).run();
      else if (editor.state.selection.empty && !editor.isActive('link')) editor.chain().focus().insertContent({ type:'text', text:alternative || valid, marks:[{ type:'link',attrs:{ href:valid,target:'_blank',rel:'noopener noreferrer' } }] }).run();
      else editor.chain().focus().extendMarkRange('link').setLink({ href:valid }).run();
    }
    setInsert(null); setNotice('');
  }
  const preview = mode === 'preview' ? value().html : '';
  useEffect(() => {
    if (mode !== 'preview') return;
    let cancelled = false;
    // Opaque sandbox frames cannot read the parent origin's blob URLs. Embed only
    // the known local raster files after sanitizing the preview HTML above.
    const files = usedComposerFiles(getFiles(),preview).filter(file => file.inline);
    encodeComposerFiles(files).then(encoded => {
      if (cancelled) return;
      const doc = new DOMParser().parseFromString(preview,'text/html');
      for (const img of doc.querySelectorAll('img')) {
        const file = encoded.find(file => `cid:${file.contentId}` === img.getAttribute('src'));
        if (file) img.setAttribute('src',`data:${file.contentType};base64,${file.contentBase64}`);
      }
      setPreviewState({ source:preview,html:doc.body.innerHTML });
    }).catch(() => { if (!cancelled) setNotice('Unable to load an image in preview. Remove and add that image again.'); });
    return () => { cancelled=true; };
  },[mode,preview,getFiles]);
  return <section className="mail-rich-editor" aria-label="Rich text message editor">
    <div className="mail-editor-top"><strong>Message</strong><div className="mail-editor-modes" role="group" aria-label="Message view">{([['write','Write',PenLine],['html','HTML',Code2],['preview','Preview',Eye]] as const).map(([key,label,Icon]) => <button type="button" key={key} aria-pressed={mode === key} onClick={() => switchMode(key)} disabled={disabled}><Icon size={13} aria-hidden="true"/>{label}</button>)}</div></div>
    {mode === 'write' && <>
      <fieldset className="mail-editor-toolbar" disabled={disabled || !editor} aria-label="Message formatting">
        <div className="mail-editor-toolbar-row">
          <select aria-label="Text style" value={ui?.heading || 'paragraph'} onChange={event => { const level=Number(event.target.value); if (level) editor?.chain().focus().setHeading({ level:level as 1|2|3 }).run(); else editor?.chain().focus().setParagraph().run(); }}><option value="paragraph">Normal text</option><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option></select>
          <select aria-label="Font family" value={ui?.font || 'Arial'} onChange={event => editor?.chain().focus().setFontFamily(event.target.value).run()}>{ui?.font && !fonts.includes(ui.font) && <option value={ui.font}>{ui.font}</option>}{fonts.map(font => <option key={font} value={font}>{font}</option>)}</select>
          <select className="mail-editor-size" aria-label="Font size" value={ui?.size || '14px'} onChange={event => editor?.chain().focus().setFontSize(event.target.value).run()}>{ui?.size && !sizes.includes(ui.size) && <option value={ui.size}>{ui.size}</option>}{sizes.map(size => <option key={size} value={size}>{size.replace('px','')}</option>)}</select>
          <span className="mail-toolbar-divider"/>
          <span className="mail-editor-history"><Tool icon={Undo2} label="Undo" disabled={!ui?.undo} action={() => { editor?.chain().focus().undo().run(); }}/><Tool icon={Redo2} label="Redo" disabled={!ui?.redo} action={() => { editor?.chain().focus().redo().run(); }}/></span>
        </div>
        <div className="mail-editor-toolbar-row">
          <Tool icon={Bold} label="Bold" active={ui?.bold} action={() => { editor?.chain().focus().toggleBold().run(); }}/><Tool icon={Italic} label="Italic" active={ui?.italic} action={() => { editor?.chain().focus().toggleItalic().run(); }}/><Tool icon={Underline} label="Underline" active={ui?.underline} action={() => { editor?.chain().focus().toggleUnderline().run(); }}/><Tool icon={Strikethrough} label="Strikethrough" active={ui?.strike} action={() => { editor?.chain().focus().toggleStrike().run(); }}/>
          <label className="mail-editor-color" title="Text color"><span aria-hidden="true">A</span><input type="color" aria-label="Text color" defaultValue="#263345" onChange={event => editor?.chain().focus().setColor(event.target.value).run()}/></label>
          <label className="mail-editor-color highlight" title="Highlight color"><Highlighter size={15} aria-hidden="true"/><input type="color" aria-label="Highlight color" defaultValue="#fff0a6" onChange={event => editor?.chain().focus().setBackgroundColor(event.target.value).run()}/></label>
          <span className="mail-toolbar-divider"/>
          {([[AlignLeft,'left'],[AlignCenter,'center'],[AlignRight,'right'],[AlignJustify,'justify']] as const).map(([Icon,align]) => <Tool key={align} icon={Icon} label={`Align ${align}`} active={ui?.alignment === align} action={() => { editor?.chain().focus().setTextAlign(align).run(); }}/>)}
          <span className="mail-toolbar-divider"/>
          <Tool icon={List} label="Bullet list" active={ui?.bullet} action={() => { editor?.chain().focus().toggleBulletList().run(); }}/><Tool icon={ListOrdered} label="Numbered list" active={ui?.numbered} action={() => { editor?.chain().focus().toggleOrderedList().run(); }}/>
          <Tool icon={IndentDecrease} label="Decrease list indent" action={() => { editor?.chain().focus().liftListItem('listItem').run(); }}/><Tool icon={IndentIncrease} label="Increase list indent" action={() => { editor?.chain().focus().sinkListItem('listItem').run(); }}/>
          <Tool icon={Quote} label="Quote" active={ui?.quote} action={() => { editor?.chain().focus().toggleBlockquote().run(); }}/><Tool icon={Minus} label="Horizontal line" action={() => { editor?.chain().focus().setHorizontalRule().run(); }}/>
          <span className="mail-toolbar-divider"/>
          <Tool icon={Link2} label="Insert or edit link" active={ui?.link} action={() => openInsert('link')}/><Tool icon={Unlink} label="Remove link" disabled={!ui?.link} action={() => { editor?.chain().focus().unsetLink().run(); }}/><Tool icon={ImagePlus} label="Insert image from URL" action={() => openInsert('image')}/><Tool icon={Table2} label="Insert table" active={ui?.table} action={() => openInsert('table')}/><Tool icon={Eraser} label="Clear formatting" action={() => { editor?.chain().focus().unsetAllMarks().clearNodes().resetAttributes('paragraph',['pastedStyle','textAlign']).run(); }}/>
        </div>
      </fieldset>
      {insert && <fieldset disabled={disabled} className="mail-editor-insert" role="group" aria-label={`Insert ${insert}`}>
        {insert === 'table' ? <><label>Rows<input aria-label="Table rows" type="number" min={1} max={12} value={rows} onChange={event => setRows(Math.min(12,Math.max(1,Number(event.target.value))))}/></label><label>Columns<input aria-label="Table columns" type="number" min={1} max={12} value={columns} onChange={event => setColumns(Math.min(12,Math.max(1,Number(event.target.value))))}/></label></> : <><label>{insert === 'image' ? 'Image URL' : 'Link URL'}<input aria-label={insert === 'image' ? 'Image URL' : 'Link URL'} type="url" autoFocus value={url} placeholder="https://…" onChange={event => setUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyInsert(); } }}/></label>{insert === 'image' || editor?.state.selection.empty ? <label>{insert === 'image' ? 'Image description' : 'Link text'}<input value={alternative} onChange={event => setAlternative(event.target.value)} placeholder="Optional"/></label> : null}</>}
        <button type="button" className="secondary-button" onClick={applyInsert}>Insert {insert}</button><button type="button" className="icon-button" aria-label="Close insert panel" onClick={() => setInsert(null)}><X size={16}/></button>
      </fieldset>}
      {ui?.table && <fieldset disabled={disabled} className="mail-table-actions" role="group" aria-label="Table editing"><span>Table</span><button type="button" onClick={() => editor?.chain().focus().addRowAfter().run()}>+ Row</button><button type="button" onClick={() => editor?.chain().focus().addColumnAfter().run()}>+ Column</button><button type="button" onClick={() => editor?.chain().focus().deleteRow().run()}>Delete row</button><button type="button" onClick={() => editor?.chain().focus().deleteColumn().run()}>Delete column</button><button type="button" onClick={() => editor?.chain().focus().mergeOrSplit().run()}>Merge / split</button><button type="button" onClick={() => editor?.chain().focus().deleteTable().run()}>Remove table</button></fieldset>}
    </>}
    <div hidden={mode !== 'write'}><EditorContent editor={editor}/></div>
    {mode === 'html' && <textarea className="mail-editor-source" aria-label="Message HTML source" spellCheck={false} value={source} disabled={disabled} onChange={event => { setSource(event.target.value); onChange({ html:event.target.value, text:plainTextFromComposerHtml(cleanComposerHtml(event.target.value)), empty:!event.target.value.trim() }); }}/>}
    {mode === 'preview' && previewState.source !== preview && <div className="mail-editor-loading" role="status">Preparing email preview…</div>}
    {mode === 'preview' && previewState.source === preview && <iframe title="Formatted email preview" className="mail-editor-preview" sandbox="" referrerPolicy="no-referrer" srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; base-uri 'none'; form-action 'none'"><style>body{margin:0;padding:24px}img{max-width:100%}table{max-width:100%}</style></head><body>${previewState.html}</body></html>`}/>}
    <div className="mail-editor-bottom"><div className="mail-paste-options" role="group" aria-label="Paste behavior"><span>Paste</span><button type="button" aria-pressed={!plainPaste} disabled={disabled} onClick={() => { setPlainPaste(false); plainPasteRef.current=false; }}>Keep formatting</button><button type="button" aria-pressed={plainPaste} disabled={disabled} onClick={() => { setPlainPaste(true); plainPasteRef.current=true; }}>Plain text</button></div><small>Ctrl/Cmd + Shift + V for plain text</small></div>
    {notice && <div className="mail-editor-notice" role="status">{notice}<button type="button" aria-label="Dismiss editor notice" onClick={() => setNotice('')}><X size={12}/></button></div>}
  </section>;
}

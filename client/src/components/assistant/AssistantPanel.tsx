import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Maximize2, Minimize2, PawPrint, Plus, RotateCcw, Send, Square, Trash2, X } from 'lucide-react';
import { api, apiEnvelope } from '../../lib/api';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirmation } from '../Confirm';
import './assistant.css';

type Message = { role: 'user' | 'assistant'; content: string; created_at?: string };
type Bootstrap = { enabled: boolean; account_type: 'user' | 'staff' | 'super_administrator'; suggestions: string[] };
const welcome: Record<Bootstrap['account_type'], string> = {
  user: 'I can help you find a pet, track your applications and orders, report an animal in need, donate or volunteer.',
  staff: 'I can check the work waiting in your assigned modules and help you find records and the right screen.',
  super_administrator: 'I can summarize system status, open alerts and access requests, and point you to the right administration screen.',
};

/** Assistant text is rendered as plain React nodes: bold, lists and links only, never HTML. */
function inline(text: string, onNavigate: () => void): ReactNode[] {
  return text.split(/(\*\*.+?\*\*|\[[^\]]+\]\([^)\s]+\))/g).map((part, index) => {
    const bold = /^\*\*(.+)\*\*$/.exec(part);
    // Models often wrap a link in bold, so the inside of a bold run is parsed again.
    if (bold) return <strong key={index}>{inline(bold[1], onNavigate)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (!link) return part;
    // Only in-app paths become links; anything else stays as readable text.
    return /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(link[2]) ? <Link key={index} to={link[2]} onClick={onNavigate}>{link[1]}</Link> : `${link[1]} (${link[2]})`;
  });
}
function Rendered({ text, onNavigate }: { text: string; onNavigate: () => void }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { const items = list; blocks.push(<ul key={blocks.length}>{items.map((item, index) => <li key={index}>{inline(item, onNavigate)}</li>)}</ul>); list = []; } };
  for (const line of text.split('\n')) {
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) { list.push(item[1]); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#{1,4}\s+/, ''), onNavigate)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

export default function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { profile } = useAuth();
  const { pathname } = useLocation();
  const confirm = useConfirmation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState(''), [activity, setActivity] = useState(''), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(false), [hasMore, setHasMore] = useState(false);
  const fresh = useRef(false), seeded = useRef(false), request = useRef<AbortController | null>(null), lastSent = useRef('');
  const scroller = useRef<HTMLDivElement>(null), field = useRef<HTMLTextAreaElement>(null);

  const bootstrap = useQuery({ queryKey: ['assistant', 'bootstrap'], enabled: open, queryFn: ({ signal }) => api<Bootstrap>('/assistant/bootstrap', { signal }) });
  const history = useQuery({ queryKey: ['assistant', 'messages'], enabled: open, staleTime: Infinity, queryFn: ({ signal }) => apiEnvelope<Message[]>('/assistant/messages', { signal }) });
  useEffect(() => {
    if (!history.data || seeded.current) return;
    seeded.current = true; setMessages(history.data.data); setHasMore(Boolean((history.data.meta as { has_more?: boolean } | undefined)?.has_more));
  }, [history.data]);
  useEffect(() => { if (open) field.current?.focus(); }, [open]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [messages, activity, open]);
  // A reply in flight stops when the panel unmounts (sign-out or account switch).
  useEffect(() => () => request.current?.abort(), []);

  async function ask(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true); setError(''); setDraft(''); setActivity('Thinking'); lastSent.current = message;
    setMessages(current => [...current, { role: 'user', content: message }, { role: 'assistant', content: '' }]);
    const controller = new AbortController(); request.current = controller;
    const append = (delta: string) => setMessages(current => current.map((item, index) => index === current.length - 1 ? { ...item, content: item.content + delta } : item));
    let failed = '';
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/assistant/chat`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ message, page: /^\/[A-Za-z0-9/_-]*$/.test(pathname) ? pathname.slice(0, 120) : '/', new_conversation: fresh.current }),
      });
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => null))?.error?.message || 'I’m having trouble responding right now. You can still use the PawsConnect features normally.');
      fresh.current = false;
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n'); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1], data = JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? '{}');
          if (event === 'delta') { setActivity(''); append(data.text); }
          else if (event === 'tool') setActivity(data.label);
          else if (event === 'error') failed = data.message;
        }
      }
    } catch (failure) {
      if (!controller.signal.aborted) failed = failure instanceof Error && failure.name !== 'TypeError' ? failure.message : 'The connection was interrupted. Check your internet and try again.';
    } finally {
      request.current = null; setBusy(false); setActivity('');
      // An empty reply bubble is removed; whatever text did arrive is kept.
      setMessages(current => current.at(-1)?.role === 'assistant' && !current.at(-1)!.content.trim() ? current.slice(0, -1) : current);
      if (failed) setError(failed);
      field.current?.focus();
    }
  }
  function submit(event: FormEvent) { event.preventDefault(); void ask(draft); }
  function retry() {
    // Drop the unanswered question before sending it again so it is not shown twice.
    setMessages(current => current.at(-1)?.role === 'user' ? current.slice(0, -1) : current);
    void ask(lastSent.current);
  }
  function startNew() { request.current?.abort(); fresh.current = true; setMessages([]); setHasMore(false); setError(''); field.current?.focus(); }
  async function clearHistory() {
    if (!(await confirm('Delete your whole assistant conversation history? This cannot be undone.')).confirmed) return;
    request.current?.abort();
    try { await api('/assistant/messages', { method: 'DELETE' }); fresh.current = true; setMessages([]); setHasMore(false); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Your history could not be deleted. Please try again.'); }
  }
  async function loadEarlier() {
    const first = messages.find(item => item.created_at)?.created_at;
    if (!first) return;
    try {
      const page = await apiEnvelope<Message[]>(`/assistant/messages?before=${encodeURIComponent(first)}`);
      setMessages(current => [...page.data, ...current]); setHasMore(Boolean((page.meta as { has_more?: boolean } | undefined)?.has_more));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Earlier messages could not be loaded.'); }
  }

  if (!open) return null;
  const unavailable = bootstrap.data && !bootstrap.data.enabled;
  const name = profile?.full_name?.split(' ')[0];
  return <section className={`assistant-panel${expanded ? ' assistant-expanded' : ''}`} role="dialog" aria-label="PawsConnect AI Assistant" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <header className="assistant-header">
      <span className="assistant-mark"><PawPrint size={18} /></span>
      <div><strong>PawsConnect AI Assistant</strong><small>Answers from your own account’s records</small></div>
      <button type="button" className="icon-button" onClick={startNew} aria-label="Start a new conversation" title="New conversation"><Plus size={18} /></button>
      <button type="button" className="icon-button" onClick={clearHistory} aria-label="Delete conversation history" title="Delete history"><Trash2 size={17} /></button>
      <button type="button" className="icon-button assistant-resize" onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Use the compact view' : 'Use the larger view'} title={expanded ? 'Compact view' : 'Larger view'}>{expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close assistant" title="Close"><X size={19} /></button>
    </header>
    <div className="assistant-messages" ref={scroller} aria-live="polite">
      {hasMore && <button type="button" className="text-button assistant-earlier" onClick={loadEarlier}>Show earlier messages</button>}
      {bootstrap.isPending || history.isPending ? <div className="assistant-note" role="status">Opening the assistant…</div> : <>
        {bootstrap.error && <div className="assistant-note assistant-error" role="alert">{bootstrap.error.message} <button type="button" className="text-button" onClick={() => void bootstrap.refetch()}>Retry</button></div>}
        {unavailable && <div className="assistant-note" role="status">The assistant is not set up yet. You can still use every PawsConnect feature normally.</div>}
        {!messages.length && bootstrap.data?.enabled && <div className="assistant-welcome">
          <p><strong>Hi{name ? `, ${name}` : ''}.</strong> {welcome[bootstrap.data.account_type]}</p>
          <div className="assistant-suggestions">{bootstrap.data.suggestions.map(prompt => <button type="button" key={prompt} onClick={() => void ask(prompt)} disabled={busy}>{prompt}</button>)}</div>
        </div>}
        {messages.map((message, index) => message.content.trim() || message.role === 'user' ? <div key={index} className={`assistant-message assistant-${message.role}`}>{message.role === 'assistant' ? <Rendered text={message.content} onNavigate={() => { if (window.innerWidth <= 600) onClose(); }} /> : message.content}</div> : null)}
        {busy && activity && <div className="assistant-activity" role="status"><span className="assistant-dots" aria-hidden="true"><i /><i /><i /></span>{activity}…</div>}
        {error && <div className="assistant-note assistant-error" role="alert">{error} {lastSent.current && <button type="button" className="text-button" onClick={retry}><RotateCcw size={13} />Try again</button>}</div>}
      </>}
    </div>
    <form className="assistant-input" onSubmit={submit}>
      <textarea ref={field} rows={1} value={draft} maxLength={2000} disabled={Boolean(unavailable)} aria-label="Message the assistant" placeholder="Ask about your account or how to do something…" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(draft); } }} />
      {busy ? <button type="button" className="assistant-send" onClick={() => request.current?.abort()} aria-label="Stop the reply" title="Stop"><Square size={16} /></button>
        : <button type="submit" className="assistant-send" disabled={!draft.trim() || Boolean(unavailable)} aria-label="Send message" title="Send"><Send size={17} /></button>}
    </form>
    <p className="assistant-footnote">AI answers can be wrong. Check important details on the linked page.</p>
  </section>;
}

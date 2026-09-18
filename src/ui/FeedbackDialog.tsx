import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import pkg from '../../package.json';
import type { InstalledPlugin } from '../host/plugins/store';

/** Where submissions land — a Cloudflare Worker that turns them into a
 * GitHub issue on the public tracker. See worker/README.md for setup. */
const FEEDBACK_ENDPOINT = 'https://feedback.promenade.run/submit';

/** Cloudflare Turnstile site key — public, safe to embed. The matching
 * secret key lives only as the worker's TURNSTILE_SECRET_KEY, set with
 * `wrangler secret put` (see worker/README.md); it must never appear here. */
const TURNSTILE_SITE_KEY = '0x4AAAAAAEqmn6koaw5k4pe6';

/** Bound into the widget and re-checked server-side against siteverify's
 * `action` field, so a token minted for this form can't be replayed against
 * a different endpoint that happens to share the same secret key. */
const TURNSTILE_ACTION = 'feedback-submit';

type Category = 'feature' | 'bug' | 'help';
const CATEGORIES: Array<{ id: Category; label: string; placeholder: string }> = [
  {
    id: 'feature',
    label: 'Feature Request',
    placeholder: "Describe the feature you'd like to see. What problem does it solve? How would you use it?",
  },
  {
    id: 'bug',
    label: 'Bug Report',
    placeholder: 'What went wrong? What were you doing when it happened, what did you expect, and what happened instead?',
  },
  {
    id: 'help',
    label: 'Help / Other',
    placeholder: 'What are you trying to do, and where are you stuck?',
  },
];

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; action?: string; callback: (token: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void }) => string;
      reset: (widgetId?: string) => void;
    };
  }
}

/** Loads the Turnstile script once and calls back when `window.turnstile` is ready. */
function useTurnstileScript() {
  const [ready, setReady] = useState(!!window.turnstile);
  useEffect(() => {
    if (window.turnstile) { setReady(true); return; }
    const existing = document.querySelector('script[data-turnstile]');
    if (existing) { existing.addEventListener('load', () => setReady(true)); return; }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    script.dataset.turnstile = 'true';
    script.addEventListener('load', () => setReady(true));
    document.head.appendChild(script);
  }, []);
  return ready;
}

/**
 * Help-menu "Send feedback…" replacement: a small form that files a GitHub
 * issue through a Cloudflare Worker, instead of just opening the tracker and
 * leaving the user to write the issue themselves. Version info is attached
 * automatically (disclosed inline) — everything else sent is exactly what's
 * visible in the form, which is the reassurance this dialog also gives.
 */
export function FeedbackDialog({ onClose, plugins }: {
  onClose: () => void;
  plugins: InstalledPlugin[];
}) {
  const [category, setCategory] = useState<Category>('feature');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [about, setAbout] = useState<'promenade' | 'plugin' | 'none'>('promenade');
  const [pluginId, setPluginId] = useState(plugins[0]?.manifest.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const messagePlaceholder = CATEGORIES.find((c) => c.id === category)!.placeholder;

  const turnstileReady = useTurnstileScript();
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    if (!turnstileReady || !turnstileRef.current || widgetId.current) return;
    widgetId.current = window.turnstile!.render(turnstileRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      action: TURNSTILE_ACTION,
      callback: (token) => setTurnstileToken(token),
      'expired-callback': () => setTurnstileToken(null),
      'error-callback': () => setTurnstileToken(null),
    });
  }, [turnstileReady]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const canSubmit = message.trim().length > 0 && !!turnstileToken && !submitting
    && (about === 'promenade' || !!pluginId);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const selectedPlugin = plugins.find((p) => p.manifest.id === pluginId);
      const res = await fetch(FEEDBACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          message: message.trim(),
          email: email.trim() || undefined,
          about: about === 'promenade'
            ? { kind: 'promenade' }
            : about === 'plugin'
            ? { kind: 'plugin', pluginId, pluginName: selectedPlugin?.manifest.name ?? pluginId }
            : { kind: 'none' },
          ...(about === 'none' ? {} : {
            versions: {
              promenade: pkg.version,
              plugins: plugins.map((p) => ({ id: p.manifest.id, name: p.manifest.name, version: p.manifest.version })),
            },
          }),
          turnstileToken,
        }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      setSent(true);
    } catch {
      setError('Could not send feedback — check your connection and try again.');
      window.turnstile?.reset(widgetId.current ?? undefined);
      setTurnstileToken(null);
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}>
      <div className="modal feedback-dialog" role="dialog" aria-modal="true" aria-label="Send feedback">
        <div className="modal-title">Send Feedback</div>
        {sent ? (
          <>
            <p className="feedback-sent">Thanks — your feedback was sent.</p>
            <div className="modal-actions">
              <button className="primary" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <p className="feedback-intro">Help us improve Promenade. Your feedback is greatly appreciated!</p>

            <div className="feedback-field">
              <span className="feedback-label">Category</span>
              <div className="feedback-category-list">
                {CATEGORIES.map((c) => (
                  <label key={c.id} className={`feedback-category-option${category === c.id ? ' is-active' : ''}`}>
                    <input type="radio" name="feedback-category" checked={category === c.id}
                           onChange={() => setCategory(c.id)} />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="feedback-field">
              <span className="feedback-label">Message</span>
              <textarea
                className="modal-input feedback-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={messagePlaceholder}
                rows={5}
              />
            </div>

            <div className="feedback-field">
              <span className="feedback-label">Email <small>(optional — if you'd like a reply)</small></span>
              <input
                className="modal-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
              />
            </div>

            <div className="feedback-field">
              <span className="feedback-label">This feedback is about</span>
              <div className="feedback-about-row">
                <select className="modal-input" value={about} onChange={(e) => setAbout(e.target.value as 'promenade' | 'plugin' | 'none')}>
                  <option value="promenade">Promenade itself</option>
                  <option value="plugin" disabled={plugins.length === 0}>A specific plugin{plugins.length === 0 ? ' (none installed)' : ''}</option>
                  <option value="none">Nothing specific</option>
                </select>
                {about === 'plugin' && (
                  <select className="modal-input" value={pluginId} onChange={(e) => setPluginId(e.target.value)}>
                    {plugins.map((p) => (
                      <option key={p.manifest.id} value={p.manifest.id}>{p.manifest.name} v{p.manifest.version}</option>
                    ))}
                  </select>
                )}
              </div>
              {about !== 'none' && (
                <p className="feedback-hint">Includes your Promenade version and the versions of your installed plugins with the feedback.</p>
              )}
            </div>

            <p className="feedback-privacy">{about === 'none'
              ? "No data from the app is sent — only what's shown in this form."
              : "No other data from the app is sent — only what's shown in this form."}</p>

            <div ref={turnstileRef} className="feedback-turnstile" />

            {error && <div className="err feedback-error">{error}</div>}

            <div className="modal-actions">
              <button onClick={onClose} disabled={submitting}>Cancel</button>
              <button className="primary" disabled={!canSubmit} onClick={submit}>
                {submitting ? 'Sending…' : 'Send Feedback'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

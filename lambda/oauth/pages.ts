// HTML pages for the OAuth AS. Every page has a strict CSP with a per-response nonce
// (technical design §5.4). All dynamic text is HTML-escaped; strings come from i18n.json.
import { randomBytes } from 'node:crypto';
import { html, type HttpResult } from '../shared/http';
import i18n from './i18n.json';

export type Lang = keyof typeof i18n;
export type MsgKey = keyof (typeof i18n)['en'];
export type ErrorKey = Extract<MsgKey, `err_${string}`>;

export function detectLang(acceptLanguage: string | undefined): Lang {
  if (!acceptLanguage) return 'en';
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const qv = q ? Number(q.slice(2)) : 1;
      return { lang: tag.trim().toLowerCase().split('-')[0] ?? '', q: Number.isFinite(qv) ? qv : 0 };
    })
    .filter((e) => e.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { lang } of ranked) if (lang === 'zh' || lang === 'en') return lang;
  return 'en';
}

export function t(lang: Lang, key: MsgKey): string {
  return i18n[lang][key];
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

const STYLE =
  'body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:36rem;margin:8vh auto;padding:0 1.5rem;color:#1a1a1a}' +
  'h2{margin-bottom:.4rem}.ok{color:#0a7d2c}.err{color:#b42318}.hint{color:#666;font-size:.92rem}' +
  '.warn{background:#fff7e6;border-left:4px solid #fa8c16;padding:.8rem 1rem;margin:1.2rem 0;font-size:.94rem}' +
  '#qr{border:1px solid #e8e8e8;border-radius:8px;padding:10px;background:#fff;display:block}' +
  'a.btn{display:inline-block;background:#07c160;color:#fff;padding:.6rem 1.2rem;border-radius:6px;text-decoration:none}';

function page(lang: Lang, title: string, bodyHtml: string, statusCode: number, opts: { script?: (nonce: string) => string; images?: boolean } = {}): HttpResult {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    ...(opts.images ? ['img-src data:'] : []),
    `style-src 'nonce-${nonce}'`,
    ...(opts.script ? [`script-src 'nonce-${nonce}'`, "connect-src 'self'"] : []),
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  const body =
    `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<style nonce="${nonce}">${STYLE}</style></head><body>${bodyHtml}` +
    (opts.script ? `<script nonce="${nonce}">${opts.script(nonce)}</script>` : '') +
    '</body></html>';
  return html(statusCode, body, { 'Content-Security-Policy': csp });
}

export function errorPage(lang: Lang, key: ErrorKey, statusCode = 400, headers: Record<string, string> = {}): HttpResult {
  const r = page(
    lang,
    t(lang, 'title_error'),
    `<h2 class="err">${escapeHtml(t(lang, 'title_error'))}</h2><p>${escapeHtml(t(lang, key))}</p><p class="hint">${escapeHtml(t(lang, 'error_hint'))}</p>`,
    statusCode,
  );
  return { ...r, headers: { ...r.headers, ...headers } };
}

export function successPage(lang: Lang, displayName: string): HttpResult {
  const msg = escapeHtml(t(lang, 'success_message')).replace('%s', `<strong>${escapeHtml(displayName)}</strong>`);
  return page(
    lang,
    t(lang, 'title_success'),
    `<h2 class="ok">${escapeHtml(t(lang, 'title_success'))}</h2><p>${msg}</p><p class="hint">${escapeHtml(t(lang, 'success_hint'))}</p>`,
    200,
  );
}

export interface QrPageInput {
  flow: string;
  authorizeUrl: string;
  qrPngBase64?: string;
}

/** Polls /authorize/status every 2 s for up to 310 s, then location.replace(redirect). */
export function qrPage(lang: Lang, p: QrPageInput): HttpResult {
  const png = p.qrPngBase64 && /^[A-Za-z0-9+/=]+$/.test(p.qrPngBase64) ? p.qrPngBase64 : undefined;
  const link = /^https:\/\//.test(p.authorizeUrl) ? p.authorizeUrl : '';
  const qrBlock = png
    ? `<img id="qr" alt="QR" width="240" height="240" src="data:image/png;base64,${png}">`
    : `<p><a class="btn" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(lang, 'qr_open_link'))}</a></p><p class="hint">${escapeHtml(t(lang, 'qr_no_image'))}</p>`;
  const body =
    `<h2>${escapeHtml(t(lang, 'qr_heading'))}</h2><p class="hint">${escapeHtml(t(lang, 'qr_intro'))}</p>` +
    `<div class="warn">${escapeHtml(t(lang, 'qr_warning'))}</div>${qrBlock}` +
    `<p id="s">${escapeHtml(t(lang, 'qr_waiting'))}</p><p class="hint">${escapeHtml(t(lang, 'qr_bind_existing'))}</p>`;
  const msgs = { done: t(lang, 'qr_done'), failed: t(lang, 'qr_failed'), timeout: t(lang, 'qr_timeout'), approval: t(lang, 'qr_pending_approval'), revoked: t(lang, 'err_access_revoked') };
  // JSON.stringify output is embedded in a script; escape '<' so no "</script>" can appear.
  const js = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');
  const script = (): string =>
    `const f=${js(p.flow)},m=${js(msgs)},t0=Date.now(),s=document.getElementById('s');` +
    `async function tick(){try{const r=await fetch('/authorize/status?flow='+encodeURIComponent(f),{cache:'no-store'});` +
    `const d=await r.json();if(d.status==='authorized'&&d.redirect){s.textContent=m.done;location.replace(d.redirect);return}` +
    `if(d.status==='pending_approval'){s.textContent=m.approval;return}` +
    `if(d.status==='expired'||d.status==='failed'){s.textContent=d.reason==='access_revoked'?m.revoked:m.failed;return}}catch(e){}` +
    `if(Date.now()-t0>310000){s.textContent=m.timeout;return}setTimeout(tick,2000)}setTimeout(tick,2000);`;
  return page(lang, t(lang, 'title_qr'), body, 200, { script, images: true });
}

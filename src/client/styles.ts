export const CSS = `
.dshu-root {
  --dshu-border: var(--dsw-border, color-mix(in srgb, currentColor 16%, transparent));
  --dshu-bg: var(--dsw-surface, transparent);
  --dshu-muted: var(--dsw-text-secondary, color-mix(in srgb, currentColor 62%, transparent));
  --dshu-accent: var(--dsw-accent, #4f7cff);
  --dshu-danger: var(--dsw-danger, #d14b4b);
  --dshu-warn: var(--dsw-warning, #b7791f);
  --dshu-radius: 10px;
  color: inherit;
  font: inherit;
  padding: 24px 28px 96px;
  width: 100%;
  max-width: 980px;
  height: 100%;
  min-height: 0;
  max-height: 100%;
  margin: 0 auto;
  flex: 1 1 auto;
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.dshu-root * { box-sizing: border-box; }
.dshu-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.dshu-title { font-size: 20px; font-weight: 650; margin: 0 0 6px; }
.dshu-sub { color: var(--dshu-muted); font-size: 13px; line-height: 1.6; margin: 0; }
.dshu-steps { display: flex; gap: 6px; flex-wrap: wrap; margin: 18px 0 20px; }
.dshu-step { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--dshu-border); color: var(--dshu-muted); }
.dshu-step[data-active="true"] { color: var(--dshu-accent); border-color: var(--dshu-accent); }
.dshu-step[data-done="true"] { color: inherit; }
.dshu-card { border: 1px solid var(--dshu-border); border-radius: var(--dshu-radius); padding: 16px 18px; margin-bottom: 14px; background: var(--dshu-bg); }
.dshu-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dshu-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.dshu-kv { display: flex; flex-direction: column; gap: 2px; }
.dshu-k { color: var(--dshu-muted); font-size: 12px; }
.dshu-v { font-size: 14px; font-weight: 550; word-break: break-all; }
.dshu-actions { position: sticky; bottom: 0; z-index: 2; display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; margin-top: 18px; padding: 12px 0 4px; border-top: 1px solid var(--dshu-border); background: var(--dsw-alias-bg-base, var(--dsw-surface, transparent)); }
.dshu-btn { appearance: none; border: 1px solid var(--dshu-border); background: transparent; color: inherit; border-radius: 8px; padding: 8px 14px; font: inherit; font-size: 13px; cursor: pointer; }
.dshu-btn:hover:not(:disabled) { border-color: var(--dshu-accent); }
.dshu-btn:disabled { opacity: .45; cursor: not-allowed; }
.dshu-btn[data-kind="primary"] { background: var(--dshu-accent); border-color: var(--dshu-accent); color: #fff; }
.dshu-btn[data-kind="danger"] { color: var(--dshu-danger); border-color: color-mix(in srgb, var(--dshu-danger) 50%, transparent); }
.dshu-btn[data-kind="link"] { border: 0; padding: 2px 4px; color: var(--dshu-accent); }
.dshu-list { display: flex; flex-direction: column; gap: 8px; }
.dshu-item { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--dshu-border); border-radius: 8px; }
.dshu-item[data-selected="true"] { border-color: var(--dshu-accent); }
.dshu-item-main { flex: 1; min-width: 0; }
.dshu-item-title { font-size: 13px; font-weight: 550; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dshu-item-meta { color: var(--dshu-muted); font-size: 12px; margin-top: 4px; line-height: 1.5; word-break: break-all; }
.dshu-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dshu-border); color: var(--dshu-muted); white-space: nowrap; }
.dshu-badge[data-tone="ok"] { color: #2f855a; border-color: color-mix(in srgb, #2f855a 45%, transparent); }
.dshu-badge[data-tone="bad"] { color: var(--dshu-danger); border-color: color-mix(in srgb, var(--dshu-danger) 45%, transparent); }
.dshu-badge[data-tone="warn"] { color: var(--dshu-warn); border-color: color-mix(in srgb, var(--dshu-warn) 45%, transparent); }
.dshu-note { font-size: 12px; color: var(--dshu-muted); line-height: 1.6; }
.dshu-alert { border: 1px solid color-mix(in srgb, var(--dshu-danger) 45%, transparent); color: var(--dshu-danger); border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.55; }
.dshu-warnbox { border: 1px solid color-mix(in srgb, var(--dshu-warn) 45%, transparent); border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.55; }
.dshu-radio { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
.dshu-radio input { margin-top: 3px; }
.dshu-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dshu-table th { text-align: left; color: var(--dshu-muted); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--dshu-border); }
.dshu-table td { padding: 7px 8px; border-bottom: 1px solid var(--dshu-border); vertical-align: top; }
.dshu-table tr[data-disabled="true"] td { opacity: .55; }
.dshu-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: color-mix(in srgb, currentColor 7%, transparent); padding: 8px 10px; border-radius: 6px; overflow-wrap: anywhere; user-select: all; }
.dshu-log { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; background: color-mix(in srgb, currentColor 6%, transparent); padding: 10px 12px; border-radius: 6px; }
.dshu-progress { height: 6px; border-radius: 999px; background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; margin: 10px 0; }
.dshu-progress > span { display: block; height: 100%; background: var(--dshu-accent); transition: width .3s ease; }
.dshu-error { color: var(--dshu-danger); font-size: 12px; white-space: pre-wrap; }
.dshu-empty { color: var(--dshu-muted); font-size: 13px; padding: 8px 0; }
.dshu-icon { width: 18px; height: 18px; display: grid; place-items: center; position: relative; color: inherit; }
.dshu-icon svg { width: 18px; height: 18px; }
.dshu-icon[data-has-update="true"]::after { content: ""; position: absolute; right: -1px; top: -1px; width: 6px; height: 6px; border-radius: 50%; background: var(--dshu-accent); }
`

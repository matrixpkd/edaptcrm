/**
 * Email rendering for alerts and digests. PURE: no database, no "server-only" (unit tested).
 *
 * Each email is a list of blocks rendered twice: as simple, inline-styled HTML (tables, so it holds up in
 * Gmail, Outlook and phone clients) and as plain text. Every value that came from a person or a webhook
 * (names, product names, reasons) is escaped. The logo is loaded from APP_URL + /brand/edapt-logo.png.
 */

export type RenderedEmail = { subject: string; html: string; text: string };

export type StatItem = { label: string; value: string; note?: string | null };
export type ListItem = { title: string; detail?: string | null; href?: string | null };

export type EmailBlock =
  | { kind: "text"; text: string; muted?: boolean }
  | { kind: "stats"; items: StatItem[] }
  | { kind: "list"; items: ListItem[]; more?: { count: number; label: string; href?: string | null } | null }
  | { kind: "button"; href: string; label: string; secondary?: boolean }
  | { kind: "section"; title: string; blocks: EmailBlock[] };

export type EmailContent = {
  subject: string;
  /** hidden inbox preview line */
  preheader?: string | null;
  title: string;
  intro?: string | null;
  blocks: EmailBlock[];
  /** why the person gets this email */
  footer?: string | null;
};

const C = {
  page: "#f6f6f4",
  card: "#ffffff",
  text: "#111111",
  muted: "#6b6b66",
  border: "#e4e4df",
  brand: "#111111",
  brandText: "#ffffff",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The CRM's public URL (no trailing slash), from APP_URL. */
export function appUrl(): string {
  const raw = (process.env.APP_URL || "http://localhost:3000").trim();
  return raw.replace(/\/+$/, "");
}

/** Absolute link into the CRM, e.g. link("/today"). */
export function link(path: string): string {
  return `${appUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function contactLink(contactId: string): string {
  return link(`/contacts/${encodeURIComponent(contactId)}`);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) links into an email; anything else becomes "#". */
function safeHref(href: string): string {
  return /^https?:\/\//i.test(href) ? escapeHtml(href) : "#";
}

export function renderEmail(content: EmailContent): RenderedEmail {
  const logo = link("/brand/edapt-logo.png");
  const body = content.blocks.map(blockHtml).join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
${content.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(content.preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 4px 16px;">
<a href="${safeHref(appUrl())}" style="text-decoration:none;"><img src="${safeHref(logo)}" width="112" height="32" alt="Edapt" style="display:block;border:0;outline:none;height:32px;width:112px;"></a>
</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:24px 20px;font-family:${FONT};color:${C.text};">
<h1 style="margin:0;font-family:${FONT};font-size:20px;line-height:28px;font-weight:600;color:${C.text};">${escapeHtml(content.title)}</h1>
${content.intro ? `<p style="margin:4px 0 0;font-size:14px;line-height:20px;color:${C.muted};">${escapeHtml(content.intro)}</p>` : ""}
${body}
</td></tr>
<tr><td style="padding:16px 4px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">
${content.footer ? `${escapeHtml(content.footer)}<br>` : ""}<a href="${safeHref(appUrl())}" style="color:${C.muted};">Open Edapt CRM</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const textParts = [content.title, content.intro ?? "", ...content.blocks.map((b) => blockText(b))]
    .filter((s) => s !== "")
    .join("\n\n");
  const text = `${textParts}\n\n${content.footer ? `${content.footer}\n` : ""}Open Edapt CRM: ${appUrl()}\n`;
  return { subject: oneLine(content.subject), html, text };
}

function blockHtml(b: EmailBlock): string {
  switch (b.kind) {
    case "text":
      return `<p style="margin:16px 0 0;font-size:14px;line-height:21px;color:${b.muted ? C.muted : C.text};">${escapeHtml(b.text)}</p>`;
    case "stats": {
      if (!b.items.length) return "";
      const rows = b.items
        .map(
          (s, i) => `<tr>
<td style="padding:10px 0;${i ? `border-top:1px solid ${C.border};` : ""}font-size:14px;line-height:20px;color:${C.text};">${escapeHtml(s.label)}${
            s.note ? `<div style="font-size:12px;line-height:16px;color:${C.muted};">${escapeHtml(s.note)}</div>` : ""
          }</td>
<td align="right" style="padding:10px 0 10px 12px;${i ? `border-top:1px solid ${C.border};` : ""}font-size:16px;line-height:20px;font-weight:600;color:${C.text};white-space:nowrap;vertical-align:top;">${escapeHtml(s.value)}</td>
</tr>`,
        )
        .join("");
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">${rows}</table>`;
    }
    case "list": {
      if (!b.items.length) return "";
      const rows = b.items
        .map((it, i) => {
          const title = it.href
            ? `<a href="${safeHref(it.href)}" style="color:${C.text};font-weight:600;text-decoration:none;">${escapeHtml(it.title)}</a>`
            : `<span style="font-weight:600;">${escapeHtml(it.title)}</span>`;
          const detail = it.detail
            ? `<div style="font-size:13px;line-height:18px;color:${C.muted};margin-top:2px;">${escapeHtml(it.detail)}</div>`
            : "";
          return `<tr><td style="padding:10px 0;${i ? `border-top:1px solid ${C.border};` : ""}font-size:14px;line-height:20px;color:${C.text};">${title}${detail}</td></tr>`;
        })
        .join("");
      const more = b.more && b.more.count > 0
        ? `<tr><td style="padding:8px 0 0;font-size:13px;line-height:18px;color:${C.muted};">${
            b.more.href
              ? `<a href="${safeHref(b.more.href)}" style="color:${C.muted};">${escapeHtml(b.more.label)}</a>`
              : escapeHtml(b.more.label)
          }</td></tr>`
        : "";
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">${rows}${more}</table>`;
    }
    case "button": {
      // primary: black with white text; secondary: outlined, for an action inside a section
      const bg = b.secondary ? C.card : C.brand;
      const fg = b.secondary ? C.text : C.brandText;
      const border = b.secondary ? `border:1px solid ${C.text};` : "";
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:${b.secondary ? 12 : 20}px;"><tr><td style="background:${bg};border-radius:8px;${border}">
<a href="${safeHref(b.href)}" style="display:inline-block;padding:${b.secondary ? "9px 16px" : "12px 20px"};font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${fg};text-decoration:none;">${escapeHtml(b.label)}</a>
</td></tr></table>`;
    }
    case "section": {
      const inner = b.blocks.map(blockHtml).join("");
      if (!inner) return "";
      return `<h2 style="margin:24px 0 0;font-family:${FONT};font-size:15px;line-height:22px;font-weight:600;color:${C.text};">${escapeHtml(b.title)}</h2>${inner}`;
    }
  }
}

function blockText(b: EmailBlock): string {
  switch (b.kind) {
    case "text":
      return b.text;
    case "stats":
      return b.items.map((s) => `${s.label}: ${s.value}${s.note ? ` (${s.note})` : ""}`).join("\n");
    case "list": {
      const lines = b.items.map((it) => `- ${it.title}${it.detail ? ` — ${it.detail}` : ""}${it.href ? `\n  ${it.href}` : ""}`);
      if (b.more && b.more.count > 0) lines.push(b.more.label);
      return lines.join("\n");
    }
    case "button":
      return `${b.label}: ${b.href}`;
    case "section": {
      const inner = b.blocks.map(blockText).filter(Boolean).join("\n");
      return inner ? `${b.title.toUpperCase()}\n${inner}` : "";
    }
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

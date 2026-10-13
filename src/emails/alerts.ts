/**
 * Email copies of in-app alerts marked email = true (hot lead, unverified payment, ...). One email per person
 * per sending run, listing every alert waiting for them. PURE: data in, { subject, html, text } out.
 */
import { formatDateTime } from "@/lib/utils";
import { link, renderEmail, type RenderedEmail } from "./render";

export type AlertEmailItem = {
  title: string;
  body: string | null;
  /** absolute link to open in the CRM */
  href: string;
  createdAt: Date;
};

export function alertsSubject(items: AlertEmailItem[]): string {
  if (items.length === 1) return items[0].title;
  return `${items.length} alerts: ${items[0].title} and ${items.length - 1} more`;
}

export function alertsEmail(data: { name: string; timeZone: string; items: AlertEmailItem[] }): RenderedEmail {
  const firstName = data.name.trim().split(/\s+/)[0] || "there";
  const subject = alertsSubject(data.items);
  return renderEmail({
    subject,
    preheader: data.items[0]?.body ?? subject,
    title: data.items.length === 1 ? data.items[0].title : `${data.items.length} alerts need you`,
    intro: `Hi ${firstName}, here ${data.items.length === 1 ? "is what came up" : "is what came up since the last email"}.`,
    blocks: [
      {
        kind: "list",
        items: data.items.map((i) => ({
          title: i.title,
          detail: [i.body, formatDateTime(i.createdAt, data.timeZone)].filter(Boolean).join(" · "),
          href: i.href,
        })),
      },
      { kind: "button", href: link("/notifications"), label: "Open notifications" },
    ],
    footer: "You get these emails for alerts that need quick action, such as hot leads and payments waiting for verification.",
  });
}

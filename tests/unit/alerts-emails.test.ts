import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertsEmail, alertsSubject } from "@/emails/alerts";
import { dailyDigestEmail, dailyDigestSubject, isDigestEmpty, type DailyDigestData } from "@/emails/daily-digest";
import { escapeHtml, renderEmail } from "@/emails/render";
import { changeLabel, revenueNote, weeklySummaryEmail, weeklySummarySubject, type WeeklySummaryData } from "@/emails/weekly-summary";

const NOW = new Date("2026-10-13T03:00:00Z"); // Tue 13 Oct, 08:30 IST

function digest(over: Partial<DailyDigestData> = {}): DailyDigestData {
  return {
    user: { name: "Asha Menon", timeZone: "Asia/Kolkata" },
    now: NOW,
    sendTimeLabel: "8:30 am",
    today: { total: 0, abandoned: 0, overdue: 0, top: [] },
    newLeads: { count: 0, items: [] },
    hotLeads: { count: 0, items: [] },
    vipQuiet: { count: 0, items: [] },
    payments: null,
    ...over,
  };
}

function weekly(over: Partial<WeeklySummaryData> = {}): WeeklySummaryData {
  return {
    range: { start: new Date("2026-10-04T18:30:00Z"), end: new Date("2026-10-11T18:30:00Z"), timeZone: "Asia/Kolkata" },
    revenue: { current: 140000, previous: 100000 },
    newCustomers: 12,
    leads: { total: 40, enquiries: 55, byChannel: [{ key: "whatsapp_api", label: "WhatsApp API", count: 30 }] },
    assisted: { assistedInr: 40000, selfServeInr: 100000 },
    beyondUmer: { share: 0.25, inr: 35000 },
    atRisk: { count: 7, expectedInr: 12000 },
    unverified: { count: 2, inr: 3000, stale: 1, staleDays: 2 },
    checkouts: { abandoned: 5, recovered: 2 },
    topAdvocates: [{ contactId: "c1", name: "Ravi <b>K</b>", referrals: 3, networkInr: 25000 }],
    vipQuiet: { count: 0, quietDays: 120, items: [] },
    ...over,
  };
}

describe("email rendering", () => {
  beforeEach(() => vi.stubEnv("APP_URL", "https://crm.edapt.in/"));
  afterEach(() => vi.unstubAllEnvs());

  it("escapes everything that came from people or webhooks", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
    const mail = dailyDigestEmail(
      digest({
        today: { total: 1, abandoned: 0, overdue: 0, top: [{ contactId: "c1", name: "<img src=x onerror=alert(1)>", detail: "Call <now>" }] },
      }),
    );
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(mail.html).toContain("Call &lt;now&gt;");
  });

  it("loads the logo from APP_URL and links into the CRM", () => {
    const mail = renderEmail({ subject: "Hi", title: "Hello", blocks: [{ kind: "button", href: "https://crm.edapt.in/today", label: "Open Today" }] });
    expect(mail.html).toContain('src="https://crm.edapt.in/brand/edapt-logo.png"');
    expect(mail.html).toContain('href="https://crm.edapt.in/today"');
    expect(mail.text).toContain("Open Today: https://crm.edapt.in/today");
    // a non-http link is neutralised
    const bad = renderEmail({ subject: "x", title: "x", blocks: [{ kind: "button", href: "javascript:alert(1)", label: "x" }] });
    expect(bad.html).not.toContain("javascript:");
  });
});

describe("daily digest email", () => {
  beforeEach(() => vi.stubEnv("APP_URL", "https://crm.edapt.in"));
  afterEach(() => vi.unstubAllEnvs());

  it("is empty when there is nothing to do", () => {
    expect(isDigestEmpty(digest())).toBe(true);
    expect(isDigestEmpty(digest({ payments: { unverified: 0, unverifiedInr: 0, stale: 0, staleDays: 2, overdueInstalments: 0 } }))).toBe(true);
    expect(isDigestEmpty(digest({ vipQuiet: { count: 1, items: [] } }))).toBe(false);
    expect(isDigestEmpty(digest({ payments: { unverified: 1, unverifiedInr: 500, stale: 0, staleDays: 2, overdueInstalments: 0 } }))).toBe(false);
  });

  it("leads its subject with Today, abandoned checkouts and overdue follow-ups", () => {
    expect(dailyDigestSubject(digest({ today: { total: 12, abandoned: 1, overdue: 3, top: [] }, hotLeads: { count: 2, items: [] } }))).toBe(
      "Your day: 12 on Today, 1 abandoned checkout, 3 overdue, 2 hot leads",
    );
    expect(dailyDigestSubject(digest({ newLeads: { count: 1, items: [] } }))).toBe("Your day: 1 new lead");
    expect(
      dailyDigestSubject(digest({ payments: { unverified: 4, unverifiedInr: 9000, stale: 1, staleDays: 2, overdueInstalments: 0 } })),
    ).toBe("Your day: 4 payments to verify");
  });

  it("greets the person in their own time zone and shows the payments block to verifiers", () => {
    const mail = dailyDigestEmail(
      digest({
        today: { total: 2, abandoned: 0, overdue: 1, top: [{ contactId: "c1", name: "Ravi", detail: "Follow up on the workshop" }] },
        payments: { unverified: 3, unverifiedInr: 4500, stale: 1, staleDays: 2, overdueInstalments: 2 },
      }),
    );
    expect(mail.html).toContain("Good morning, Asha");
    expect(mail.html).toContain("https://crm.edapt.in/contacts/c1");
    expect(mail.html).toContain("Waiting for verification");
    expect(mail.html).toContain("₹4,500");
    expect(mail.html).toContain("Overdue instalments");
    expect(mail.text).toContain("Follow up on the workshop");
    expect(mail.html).toContain("every morning at 8:30 am");
  });
});

describe("weekly summary email", () => {
  it("labels week-on-week change", () => {
    expect(changeLabel(140, 100)).toBe("+40%");
    expect(changeLabel(50, 100)).toBe("-50%");
    expect(changeLabel(100, 100)).toBe("no change");
    expect(changeLabel(10, 0)).toBe("new");
    expect(changeLabel(0, 0)).toBe("no change");
    expect(revenueNote(140000, 100000)).toBe("+40% on the week before (₹1,00,000)");
    expect(revenueNote(5000, 0)).toBe("Nothing the week before");
    expect(revenueNote(0, 0)).toBe("No revenue this week or the week before");
    expect(revenueNote(100, 100)).toBe("Same as the week before (₹100)");
  });

  it("states the range, revenue and change in the subject, and escapes advocate names", () => {
    const d = weekly();
    expect(weeklySummarySubject(d)).toBe("Week of 5 Oct to 11 Oct: ₹1.4L revenue (+40%), 12 new customers");
    const mail = weeklySummaryEmail(d);
    expect(mail.html).toContain("₹1,40,000");
    expect(mail.html).toContain("25%");
    expect(mail.html).toContain("Ravi &lt;b&gt;K&lt;/b&gt;");
    expect(mail.text).toContain("Leads by channel".toUpperCase());
  });
});

describe("alert emails", () => {
  it("one alert uses its title as the subject; several are counted", () => {
    const at = new Date("2026-10-13T05:00:00Z");
    const one = [{ title: "Hot lead: Asha", body: "Grade A lead enquired", href: "https://x/contacts/1", createdAt: at }];
    expect(alertsSubject(one)).toBe("Hot lead: Asha");
    const two = [...one, { title: "Verify ₹999 from Ravi", body: null, href: "https://x/payments", createdAt: at }];
    expect(alertsSubject(two)).toBe("2 alerts: Hot lead: Asha and 1 more");
    const mail = alertsEmail({ name: "Umer Abdussalam", timeZone: "Asia/Kolkata", items: two });
    expect(mail.html).toContain("Hi Umer");
    expect(mail.html).toContain("Verify ₹999 from Ravi");
    expect(mail.text).toContain("Grade A lead enquired");
  });
});

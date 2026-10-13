import Link from "next/link";
import { headers } from "next/headers";
import { ArrowLeft, ExternalLink, PlugZap, RotateCcw, X } from "lucide-react";
import { ActionForm } from "@/components/contacts/action-form";
import { FlashBanner } from "@/components/contacts/flash-banner";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, Td, Th } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { requireUser } from "@/lib/auth/session";
import { currenciesWithRates } from "@/lib/money/fx";
import { getSettings } from "@/lib/settings";
import { cn, formatDateTime, formatRelative } from "@/lib/utils";
import { explainPayload } from "@/lib/webhooks/explain";
import { FIELD_TABLES } from "@/lib/webhooks/extract";
import { getWebhookEvent, listWebhookEvents, webhookSourceHealth, type WebhookEventFilter } from "@/lib/webhooks/queries";
import {
  isWebhookSource,
  STUCK_EVENT_MS,
  WEBHOOK_SOURCE_INFO,
  WEBHOOK_SOURCES,
  webhookEventState,
  webhookSourceLabel,
  type WebhookEventState,
  type WebhookSource,
} from "@/lib/webhooks/sources";
import { reprocessEventAction, saveFieldPathsAction, saveOptionsAction, saveSelfRatingsAction } from "./actions";
import { CopyButton } from "./_components/copy-button";
import { JsonEditor } from "./_components/json-editor";
import { OptionsForm } from "./_components/options-form";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

const FILTERS: { key: WebhookEventFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "failed", label: "Failed" },
  { key: "skipped", label: "Skipped" },
  { key: "processed", label: "Processed" },
];

const STATE_BADGE: Record<WebhookEventState, { label: string; tone: "success" | "neutral" | "danger" | "warning" }> = {
  processed: { label: "Processed", tone: "success" },
  skipped: { label: "Skipped", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  pending: { label: "In progress", tone: "warning" },
};


type SearchParams = { filter?: string; source?: string; event?: string; reprocessed?: string };

function hrefWith(sp: { filter: WebhookEventFilter; source: WebhookSource | null; event?: string | null }, hash = "events"): string {
  const q = new URLSearchParams();
  if (sp.filter !== "all") q.set("filter", sp.filter);
  if (sp.source) q.set("source", sp.source);
  if (sp.event) q.set("event", sp.event);
  const s = q.toString();
  return `/settings/integrations${s ? `?${s}` : ""}#${hash}`;
}

async function appBaseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto") ?? (/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function mask(secret: string): string {
  return secret.length >= 12 ? `••••••••${secret.slice(-4)}` : "••••••••";
}

/** Failed events, and ones interrupted mid-way; `withSkipped` also offers it for skipped ones (after a path fix). */
function canReprocess(e: { processedAt: Date | null; error: string | null; receivedAt: Date }, now: Date, withSkipped = false): boolean {
  const s = webhookEventState(e);
  return s === "failed" || (withSkipped && s === "skipped") || (s === "pending" && now.getTime() - e.receivedAt.getTime() > STUCK_EVENT_MS);
}

function StateBadge({ e }: { e: { processedAt: Date | null; error: string | null } }) {
  const b = STATE_BADGE[webhookEventState(e)];
  return <Badge tone={b.tone}>{b.label}</Badge>;
}

function ReprocessButton({ id }: { id: string }) {
  return (
    <ActionForm action={reprocessEventAction} messageClassName="mt-1 max-w-xs text-xs" aria-label="Reprocess event">
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant="outline" pendingText="Running…" className="max-sm:min-h-10">
        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        Reprocess
      </SubmitButton>
    </ActionForm>
  );
}

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUser(["admin"]);
  const sp = await searchParams;
  const filter = FILTERS.some((f) => f.key === sp.filter) ? (sp.filter as WebhookEventFilter) : "all";
  const source = isWebhookSource(sp.source) ? sp.source : null;
  const now = new Date();
  const tz = user.timezone || "Asia/Kolkata";

  const [settings, health, events, detail, base] = await Promise.all([
    getSettings([
      "integrations.fieldPaths",
      "integrations.selfRatings",
      "integrations.options",
      "lists.firstDoors",
      "ladder.families",
      "currency",
    ]),
    webhookSourceHealth(now),
    listWebhookEvents({ filter, source, limit: 50 }),
    sp.event ? getWebhookEvent(sp.event) : Promise.resolve(null),
    appBaseUrl(),
  ]);
  const failed7d = [...health.values()].reduce((n, h) => n + h.failed7d, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        back={
          <Link href="/settings" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Settings
          </Link>
        }
        title="Integrations"
        description="TagMango orders, Libromi WhatsApp chats, Meta lead forms and website forms arrive here on their own. Paste each URL into its tool, then watch the events below."
      />

      <div className="flex flex-col gap-6">
        {/* ---------------------------------------------------------------- event detail */}
        {sp.event && (
          <Card id="event" aria-labelledby="event-title" className="scroll-mt-20">
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <h2 id="event-title" className="text-sm font-semibold">
                  {detail ? `${webhookSourceLabel(detail.source)} event` : "Event not found"}
                </h2>
                {detail && <p className="mt-0.5 break-all font-mono text-xs text-muted">{detail.eventKey}</p>}
              </div>
              <Link
                href={hrefWith({ filter, source })}
                className={buttonClass("ghost", "icon", "-mr-2 -mt-1 h-9 w-9 shrink-0")}
                aria-label="Close event"
              >
                <X className="h-4 w-4" aria-hidden />
              </Link>
            </div>
            {!detail ? (
              <CardBody>
                <p className="text-sm text-muted">That event no longer exists. It may have been removed.</p>
              </CardBody>
            ) : (
              <EventDetail
                event={detail}
                tz={tz}
                now={now}
                reprocessed={sp.reprocessed === "1"}
                ctx={{
                  paths: settings["integrations.fieldPaths"],
                  selfRatings: settings["integrations.selfRatings"],
                  firstDoors: settings["lists.firstDoors"],
                  timeZone: settings["integrations.options"].timeZone,
                }}
              />
            )}
          </Card>
        )}

        {/* ---------------------------------------------------------------- URLs */}
        <Card>
          <CardHeader
            title="Webhook URLs"
            description="The token at the end of each URL is the shared secret. Keep it private; anyone with it can send leads in."
          />
          <ul className="divide-y divide-border">
            {WEBHOOK_SOURCES.map((s) => {
              const info = WEBHOOK_SOURCE_INFO[s];
              const secret = process.env[info.secretEnv] ?? "";
              const url = `${base}${info.path}`;
              const full = secret ? `${url}?token=${encodeURIComponent(secret)}` : url;
              const shown = secret ? `${url}?token=${mask(secret)}` : url;
              const h = health.get(s);
              const production = process.env.NODE_ENV === "production";
              return (
                <li key={s} className="flex flex-col gap-2 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{info.label}</h3>
                    {secret ? (
                      <Badge tone="success">Secret set</Badge>
                    ) : production ? (
                      <Badge tone="danger">No secret: every call is refused</Badge>
                    ) : (
                      <Badge tone="warning">No secret: open while in development</Badge>
                    )}
                    {h?.failed7d ? (
                      <Link
                        href={hrefWith({ filter: "failed", source: s })}
                        className="inline-flex items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-10"
                      >
                        <Badge tone="danger">{h.failed7d} failed this week</Badge>
                      </Link>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted">{info.description}</p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface-muted px-3 py-2 font-mono text-xs">
                      {shown}
                    </code>
                    <CopyButton value={full} label="Copy URL" className="shrink-0 self-start max-sm:min-h-10 sm:self-auto" />
                  </div>
                  <p className="text-xs text-muted">
                    Paste into {info.pasteInto}. {!secret && <>Set <code className="font-mono">{info.secretEnv}</code> on the server first. </>}
                    {h?.lastReceivedAt ? (
                      <>
                        Last event{" "}
                        <time dateTime={h.lastReceivedAt.toISOString()} title={formatDateTime(h.lastReceivedAt, tz)}>
                          {formatRelative(h.lastReceivedAt, now)}
                        </time>
                        {` · ${h.received7d} in the last 7 days.`}
                      </>
                    ) : (
                      "No events yet."
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
          <details className="group border-t border-border px-4 py-3 text-sm">
            <summary className="cursor-pointer select-none font-medium text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              The JSON contract for Pabbly (Meta lead forms and website forms)
            </summary>
            <div className="mt-3 flex flex-col gap-2 text-muted">
              <p>
                In the Pabbly webhook action choose POST and JSON, and map the trigger&apos;s fields into these keys. Only{" "}
                <code className="font-mono">phone</code> is required; anything else you send is kept as a form answer on the enquiry.
              </p>
              <pre className="overflow-x-auto rounded-lg bg-surface-muted p-3 font-mono text-xs text-foreground">{`{
  "phone": "9847012345",          // required
  "dial_code": "91",              // when the phone has no country code
  "name": "Full name",
  "email": "name@example.com",
  "campaign": "Claude Mastery Meta ads",
  "form_name": "Claude Mastery Oct",
  "ad_name": "Carousel 3",
  "lead_id": "1209876543210",     // Meta lead id: makes retries safe
  "product_interest": "Claude Mastery Workshop",
  "city": "Kochi",
  "answers": { "How well do you know Umer?": "Watched a few videos" },
  "consent": true
}`}</pre>
            </div>
          </details>
        </Card>

        {/* ---------------------------------------------------------------- event log */}
        <Card id="events" className="scroll-mt-20">
          <CardHeader
            title="Recent events"
            description={`The latest 50 deliveries, newest first. Every payload is kept as it arrived.${failed7d ? ` ${failed7d} failed in the last 7 days.` : ""}`}
          />
          <div className="flex flex-col gap-3 px-4 pt-3">
            <Tabs
              tabs={FILTERS.map((f) => ({ key: f.key, label: f.label, href: hrefWith({ filter: f.key, source }) }))}
              active={filter}
            />
            <nav aria-label="Filter by source" className="flex flex-wrap gap-1.5">
              {[null, ...WEBHOOK_SOURCES].map((s) => {
                const active = s === source;
                return (
                  <Link
                    key={s ?? "all"}
                    href={hrefWith({ filter, source: s })}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-10",
                      active ? "border-foreground bg-foreground text-white" : "border-border bg-surface hover:bg-surface-muted",
                    )}
                  >
                    {s ? WEBHOOK_SOURCE_INFO[s].label : "All sources"}
                  </Link>
                );
              })}
            </nav>
          </div>
          {events.length === 0 ? (
            <EmptyState
              icon={<PlugZap className="h-8 w-8" aria-hidden />}
              title={filter === "all" && !source ? "No events yet" : "Nothing matches this filter"}
              description={
                filter === "all" && !source
                  ? "Paste a URL above into TagMango, Libromi or Pabbly and send a test event. It shows up here within a second."
                  : "Try another filter or source."
              }
            />
          ) : (
            <ul className="mt-3 divide-y divide-border border-t border-border">
              {events.map((e) => {
                const state = webhookEventState(e);
                return (
                  <li
                    key={e.id}
                    className={cn(
                      "flex flex-col gap-2 px-4 py-3 md:grid md:grid-cols-[6.5rem_minmax(0,1fr)_8.5rem_auto] md:items-start md:gap-4",
                      sp.event === e.id && "bg-surface-muted/70",
                    )}
                  >
                    <div className="flex items-center gap-2 md:pt-0.5">
                      <StateBadge e={e} />
                      <span className="text-xs text-muted md:hidden">
                        <time dateTime={e.receivedAt.toISOString()} title={formatDateTime(e.receivedAt, tz)}>
                          {formatRelative(e.receivedAt, now)}
                        </time>
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm">
                        <span className="font-medium">{webhookSourceLabel(e.source)}</span>
                        {e.contactId && (
                          <>
                            <span className="text-muted"> · </span>
                            <Link href={`/contacts/${e.contactId}`} className="underline decoration-border underline-offset-2 hover:decoration-foreground">
                              {e.contactName ?? "Contact"}
                            </Link>
                          </>
                        )}
                      </p>
                      <p className="truncate font-mono text-xs text-muted" title={e.eventKey}>
                        {e.eventKey}
                      </p>
                      {e.error && (
                        <p className={cn("mt-1 line-clamp-2 text-xs", state === "failed" ? "text-danger" : "text-muted")}>{e.error}</p>
                      )}
                    </div>
                    <div className="hidden text-xs text-muted md:block">
                      <time dateTime={e.receivedAt.toISOString()} title={formatDateTime(e.receivedAt, tz)}>
                        {formatDateTime(e.receivedAt, tz)}
                      </time>
                      {e.processedAt && state === "processed" && (
                        <p className="mt-0.5">done {formatRelative(e.processedAt, now)}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-start gap-2">
                      <Link
                        href={hrefWith({ filter, source, event: e.id }, "event")}
                        className={buttonClass("outline", "sm", "max-sm:min-h-10")}
                        aria-label={`View payload of ${e.eventKey}`}
                      >
                        View
                      </Link>
                      {canReprocess(e, now) && <ReprocessButton id={e.id} />}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* ---------------------------------------------------------------- options */}
        <Card>
          <CardHeader title="Options" description="Defaults the pipes use when a payload does not say." />
          <CardBody>
            <OptionsForm
              action={saveOptionsAction}
              initial={settings["integrations.options"]}
              families={settings["ladder.families"].map((f) => ({ value: f.key, label: f.label }))}
              currencies={currenciesWithRates(settings.currency)}
            />
          </CardBody>
        </Card>

        {/* ---------------------------------------------------------------- field paths */}
        <Card>
          <CardHeader
            title="Field paths"
            description="Where to find each value when a tool sends a field under a name we do not expect. Your paths are tried before the built-in ones."
          />
          <CardBody className="flex flex-col gap-4">
            <JsonEditor
              action={saveFieldPathsAction}
              initial={JSON.stringify(settings["integrations.fieldPaths"], null, 2)}
              label="Your field paths (JSON)"
              rows={10}
              hint={
                <>
                  Source, then field, then a list of paths. Paths use dots and indexes, such as{" "}
                  <code className="font-mono">{`{"tagmango": {"phone": ["buyer.whatsapp"], "amount": ["charges.net"]}}`}</code>. Open an
                  event below to see which path each value came from.
                </>
              }
            />
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium max-sm:min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Built-in paths, in the order they are tried
              </summary>
              <div className="max-h-[28rem] overflow-y-auto border-t border-border px-3 py-2">
                {(Object.keys(FIELD_TABLES) as (keyof typeof FIELD_TABLES)[]).map((src) => (
                  <section key={src} className="py-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{src}</h3>
                    <dl className="mt-1 divide-y divide-border/70">
                      {Object.entries(FIELD_TABLES[src]).map(([field, spec]) => (
                        <div key={field} className="grid gap-1 py-1.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
                          <dt className="text-xs">
                            <span className="font-mono">{field}</span> <span className="text-muted">({spec.label})</span>
                          </dt>
                          <dd className="break-words font-mono text-[11px] leading-relaxed text-muted">{spec.paths.join(", ")}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>
            </details>
          </CardBody>
        </Card>

        {/* ---------------------------------------------------------------- self-ratings */}
        <Card>
          <CardHeader
            title="Self-ratings at the door"
            description="How answers to the TagMango checkout questions, form answers and WhatsApp one-tap replies become first door, Umer familiarity and AI knowledge. A salesperson's rating always wins."
          />
          <CardBody>
            <JsonEditor
              action={saveSelfRatingsAction}
              initial={JSON.stringify(settings["integrations.selfRatings"], null, 2)}
              label="Matchers (JSON)"
              rows={16}
              allowReset
              hint={
                <>
                  <strong className="font-medium text-foreground">questions</strong>: phrases that mark which field a question
                  fills. <strong className="font-medium text-foreground">answers</strong>: phrases that give a value (first door key
                  or level 0 to 5); answers starting with a number are read as that level.{" "}
                  <strong className="font-medium text-foreground">buttons</strong>: WhatsApp button ids or titles. Button ids like{" "}
                  <code className="font-mono">door:youtube</code>, <code className="font-mono">umer:3</code> or{" "}
                  <code className="font-mono">ai:2</code> work without an entry.
                </>
              }
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function EventDetail({
  event,
  tz,
  now,
  ctx,
  reprocessed,
}: {
  event: NonNullable<Awaited<ReturnType<typeof getWebhookEvent>>>;
  tz: string;
  now: Date;
  ctx: Parameters<typeof explainPayload>[2];
  /** just reprocessed (the action redirects here) */
  reprocessed: boolean;
}) {
  const src = isWebhookSource(event.source) ? event.source : null;
  const ex = src ? explainPayload(src, event.payload, ctx) : null;
  const state = webhookEventState(event);
  return (
    <div className="flex flex-col gap-5 p-4">
      {reprocessed && (
        <FlashBanner
          param="reprocessed"
          message={state === "skipped" ? "Reprocessed. There was nothing to do: see the note below." : "Reprocessed. It went through this time."}
        />
      )}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Status</dt>
          <dd className="mt-0.5">
            <StateBadge e={event} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Contact</dt>
          <dd className="mt-0.5">
            {event.contactId ? (
              <Link href={`/contacts/${event.contactId}`} className="inline-flex items-center gap-1 underline decoration-border underline-offset-2 hover:decoration-foreground">
                {event.contactName ?? "Open contact"} <ExternalLink className="h-3 w-3" aria-hidden />
              </Link>
            ) : (
              <span className="text-muted">None</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Received</dt>
          <dd className="mt-0.5">{formatDateTime(event.receivedAt, tz)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Processed</dt>
          <dd className="mt-0.5">{event.processedAt ? formatDateTime(event.processedAt, tz) : <span className="text-muted">Not yet</span>}</dd>
        </div>
        {event.error && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">{state === "skipped" ? "Note" : "Error"}</dt>
            <dd className={cn("mt-0.5", state === "failed" && "text-danger")}>{event.error}</dd>
          </div>
        )}
      </dl>

      {canReprocess(event, now, true) && (
        <div className="flex flex-col gap-1">
          <ReprocessButton id={event.id} />
          <p className="text-xs text-muted">Runs it again with the current field paths and settings. Nothing is recorded twice.</p>
        </div>
      )}

      {ex && (
        <section aria-labelledby="read-title" className="flex flex-col gap-2">
          <h3 id="read-title" className="text-sm font-semibold">
            What we read
          </h3>
          <p className="text-sm text-muted">{ex.verdict}</p>
          <div className="rounded-lg border border-border">
            <Table>
              <thead>
                <tr>
                  <Th>Field</Th>
                  <Th>Value</Th>
                  <Th className="hidden sm:table-cell">From path</Th>
                </tr>
              </thead>
              <tbody>
                {ex.rows.map((r) => (
                  <tr key={r.field}>
                    <Td className="whitespace-nowrap text-xs font-medium">{r.label}</Td>
                    <Td className="max-w-xs break-words text-xs">
                      {r.value ?? <span className="text-muted">Not found</span>}
                      {r.path && <span className="mt-0.5 block font-mono text-[11px] text-muted sm:hidden">from {r.path}</span>}
                    </Td>
                    <Td className="hidden font-mono text-[11px] text-muted sm:table-cell">{r.path ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          {ex.selfRatings.length > 0 && (
            <div className="text-sm">
              <p className="font-medium">Self-ratings</p>
              <ul className="mt-1 list-disc pl-5 text-muted">
                {ex.selfRatings.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {ex.answers.length > 0 && (
            <div className="text-sm">
              <p className="font-medium">Answers</p>
              <ul className="mt-1 flex flex-col gap-1 text-muted">
                {ex.answers.map((a, i) => (
                  <li key={i}>
                    <span className="text-foreground">{a.question}</span>: {a.answer}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="raw-title" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id="raw-title" className="text-sm font-semibold">
            Raw payload
          </h3>
          <CopyButton value={JSON.stringify(event.payload, null, 2)} label="Copy JSON" className="max-sm:min-h-10" />
        </div>
        <pre className="max-h-[28rem] overflow-auto rounded-lg border border-border bg-surface-muted p-3 font-mono text-xs leading-relaxed">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </section>
    </div>
  );
}

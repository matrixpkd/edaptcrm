import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/card";
import { RecordPaymentForm } from "@/components/payments/record-payment-form";
import { defaultPurchaseOrganisation } from "@/components/payments/rules";
import { can, canEditContact, canViewContact } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { resolveSurvivor } from "@/lib/contacts/internal";
import { listOrganisationOptions } from "@/lib/contacts/queries";
import { currenciesWithRates, normalizeCurrency } from "@/lib/money/fx";
import { formatPhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import { localIsoDate, validTimeZone } from "@/lib/today/time";
import { getPayableContact, listProductOptions } from "@/app/(app)/payments/_lib/queries";
import { recordPaymentAction } from "./actions";

export const metadata = { title: "Record payment" };
export const dynamic = "force-dynamic";

export default async function RecordPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const contact = await getPayableContact(id);
  if (!contact) notFound();
  if (contact.mergedIntoId) {
    // a merged record lives on in the surviving contact
    const survivor = await resolveSurvivor(contact);
    if (survivor && canViewContact(user, survivor)) redirect(`/contacts/${survivor.id}/payment`);
    notFound();
  }
  if (!canViewContact(user, contact)) notFound();
  if (!can(user, "payments.record") || !canEditContact(user, contact)) {
    return (
      <div className="mx-auto max-w-xl">
        <PageHeader title="Record payment" back={<BackLink href={`/contacts/${contact.id}`} label={contact.name} />} />
        <div className="rounded-xl border border-border bg-surface p-6 text-sm">
          <p className="font-medium">You can&apos;t record payments for this contact.</p>
          <p className="mt-1 text-muted">
            Payments are recorded by the contact&apos;s owner or a manager. Ask your manager if this customer should be yours.
          </p>
        </div>
      </div>
    );
  }

  const [settings, products, organisations] = await Promise.all([
    getSettings(["currency", "ladder.families"]),
    listProductOptions(),
    listOrganisationOptions(),
  ]);
  const withRates = currenciesWithRates(settings.currency);
  const enabled = settings.currency.enabled.map(normalizeCurrency);
  // INR first, then the enabled currencies that have a rate (Settings > Currency)
  const currencies = ["INR", ...enabled.filter((c) => c !== "INR" && withRates.includes(c))];
  const tz = validTimeZone(user.timezone);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Record payment"
        back={<BackLink href={`/contacts/${contact.id}`} label={contact.name} />}
        description={
          <>
            For <span className="font-medium text-foreground">{contact.name}</span> · <span className="tabular">{formatPhone(contact.phoneE164)}</span>
          </>
        }
      />
      <RecordPaymentForm
        action={recordPaymentAction.bind(null, contact.id)}
        cancelHref={`/contacts/${contact.id}`}
        products={products}
        families={settings["ladder.families"]}
        currencies={currencies}
        rates={settings.currency.rates}
        organisations={organisations}
        defaultOrganisationId={defaultPurchaseOrganisation(contact)}
        today={localIsoDate(new Date(), tz)}
        canVerify={can(user, "payments.verify")}
      />
    </div>
  );
}

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ChevronLeft className="h-4 w-4" aria-hidden />
      {label}
    </Link>
  );
}

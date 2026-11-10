import Link from "next/link";
import { HIDDEN_CONTACT_LABEL, type ReferralRow } from "@/lib/contacts/queries";
import { GradeBadge, StageBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/card";
import { formatDate, formatINR } from "@/lib/utils";

export function ReferralsTab({
  referrer,
  referrerVisible,
  referred,
  hiddenReferrals,
  networkValueInr,
  referralCount,
  tz,
}: {
  referrer: { id: string; name: string } | null;
  referrerVisible: boolean;
  /** only the people the viewer may open (getContactReferrals) */
  referred: ReferralRow[];
  /** how many more they referred whom the viewer may not open (a colleague's contacts): counted, never shown */
  hiddenReferrals: number;
  networkValueInr: number;
  referralCount: number;
  tz: string;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Referred by</p>
        <p className="mt-1 font-medium">
          {referrer ? (
            referrerVisible ? (
              <Link href={`/contacts/${referrer.id}`} className="underline-offset-2 hover:underline">
                {referrer.name}
              </Link>
            ) : (
              <span className="text-muted">{HIDDEN_CONTACT_LABEL}</span>
            )
          ) : (
            <span className="font-normal text-muted">Nobody recorded</span>
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Network value</p>
          <p className="tabular mt-1 text-xl font-semibold">{formatINR(networkValueInr)}</p>
          <p className="mt-0.5 text-xs text-muted">LTV of everyone they brought in</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Paying referrals</p>
          <p className="tabular mt-1 text-xl font-semibold">{referralCount}</p>
          <p className="mt-0.5 text-xs text-muted">of {referred.length + hiddenReferrals} referred</p>
        </div>
      </div>

      {hiddenReferrals > 0 && (
        <p className="text-sm text-muted">
          {hiddenReferrals === 1
            ? "1 more person they referred is owned by a colleague."
            : `${hiddenReferrals} more people they referred are owned by colleagues.`}{" "}
          Their details stay private.
        </p>
      )}

      {referred.length === 0 && hiddenReferrals === 0 && (
        <EmptyState
          title="No referrals yet"
          description="People who arrive through their TagMango affiliate link or name them as the referrer show up here."
        />
      )}
      {referred.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {referred.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-3">
              <GradeBadge grade={r.grade} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  <Link href={`/contacts/${r.id}`} className="underline-offset-2 hover:underline">
                    {r.name}
                  </Link>
                </p>
                <p className="text-xs text-muted">
                  Joined {formatDate(r.createdAt, tz)}
                  {r.ownerName ? ` · ${r.ownerName}` : " · pool"}
                </p>
              </div>
              <div className="hidden sm:block">
                <StageBadge stage={r.stage} />
              </div>
              <p className="tabular w-24 text-right text-sm font-semibold">{formatINR(r.ltvInr)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

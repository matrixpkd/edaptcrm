/**
 * Automatic lifecycle stage (spec "Lifecycle stages"). PURE.
 *
 * Eight stages: new, contacted, qualified (manual), first_purchase, repeat, advocate, dormant, lost (manual).
 * The system moves contacts through six of them; salespeople set only Qualified and Lost. Any new enquiry or
 * payment pulls a Dormant or Lost contact back into the right stage automatically.
 */
import type { Stage } from "@/db/schema";

export type StageFacts = {
  currentStage: Stage;
  stageChangedAt: Date;
  createdAt: Date;
  /** paid or part-paid purchases */
  purchaseCount: number;
  /** referred contacts who have paid */
  referralCount: number;
  /** any interaction other than an internal note logged by a team member */
  hasOutboundInteraction: boolean;
  /** max of enquiry, interaction, purchase and verified payment */
  lastActivityAt: Date | null;
  /** max of enquiry, purchase and verified payment: what pulls a Lost contact back */
  lastEnquiryOrPaymentAt: Date | null;
};

const DAY_MS = 24 * 3600 * 1000;

/**
 * Rules, in order:
 * 1. Lost stays Lost unless an enquiry or payment arrived after it was set (then the rules below decide).
 * 2. No activity (last activity, else the creation date) for more than `dormantDays` -> Dormant. Fresh activity
 *    makes the contact recent again, so it is pulled back automatically.
 * 3. Paid and referred a paying customer -> Advocate; 2+ purchases -> Repeat; 1 purchase -> First purchase
 *    (checkout buyers jump from New straight to First purchase).
 * 4. Qualified stays Qualified (set by hand).
 * 5. A team member has logged an interaction (a note does not count) -> Contacted; otherwise New.
 */
export function computeAutoStage(f: StageFacts, now: Date, dormantDays: number): Stage {
  if (f.currentStage === "lost") {
    const pulledBack = f.lastEnquiryOrPaymentAt !== null && f.lastEnquiryOrPaymentAt.getTime() > f.stageChangedAt.getTime();
    if (!pulledBack) return "lost";
  }

  const lastActivity = f.lastActivityAt ?? f.createdAt;
  if (now.getTime() - lastActivity.getTime() > dormantDays * DAY_MS) return "dormant";

  if (f.purchaseCount >= 1 && f.referralCount >= 1) return "advocate";
  if (f.purchaseCount >= 2) return "repeat";
  if (f.purchaseCount === 1) return "first_purchase";

  if (f.currentStage === "qualified") return "qualified";

  return f.hasOutboundInteraction ? "contacted" : "new";
}

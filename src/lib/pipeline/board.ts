import "server-only";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db, queryRows, type Tx } from "@/db";
import { contacts, type Role, type Stage } from "@/db/schema";
import { contactScope } from "@/lib/auth/scope";
import { isUuid } from "@/lib/utils";
import { BOARD_STAGES } from "./rules";

/**
 * The pipeline board (/pipeline): every lifecycle stage as a column, scoped by contactScope (a salesperson sees their
 * own contacts and the pool). Counts and money per column come from one grouped query; each column then shows its
 * top cards (best Edapt Score first, then the most recent activity) from one windowed query, so the board stays
 * fast at 50,000 contacts.
 */

export type BoardFilters = {
  /** "mine", "pool" or a user id */
  owner?: string | null;
  grade?: "A" | "B" | "C" | "D" | "none" | null;
  firstDoor?: string | null;
};

export type BoardCard = {
  id: string;
  name: string;
  stage: Stage;
  grade: "A" | "B" | "C" | "D" | null;
  edaptScore: number | null;
  ownerId: string | null;
  ownerName: string | null;
  nextOffer: string | null;
  ltvInr: number;
  purchaseCount: number;
  lostReason: string | null;
};

export type BoardColumn = { stage: Stage; count: number; ltvInr: number; cards: BoardCard[] };

export const CARDS_PER_COLUMN = 25;

export function boardWhere(viewer: { id: string; role: Role }, f: BoardFilters): SQL {
  const conds: (SQL | undefined)[] = [contactScope(viewer)];
  if (f.owner === "mine") conds.push(eq(contacts.ownerId, viewer.id));
  else if (f.owner === "pool") conds.push(isNull(contacts.ownerId));
  else if (f.owner && isUuid(f.owner)) conds.push(eq(contacts.ownerId, f.owner));
  if (f.grade === "none") conds.push(isNull(contacts.grade));
  else if (f.grade) conds.push(eq(contacts.grade, f.grade));
  if (f.firstDoor) conds.push(eq(contacts.firstDoor, f.firstDoor));
  return and(...conds)!;
}

export async function getBoard(
  viewer: { id: string; role: Role },
  f: BoardFilters,
  opts: { perColumn?: number; tx?: Tx } = {},
): Promise<BoardColumn[]> {
  const tx = opts.tx ?? db;
  const per = Math.min(Math.max(opts.perColumn ?? CARDS_PER_COLUMN, 1), 100);
  const where = boardWhere(viewer, f);
  const [totals, cards] = await Promise.all([
    tx
      .select({ stage: contacts.stage, n: sql<number>`count(*)::int`, ltv: sql<number>`coalesce(sum(${contacts.ltvInr}), 0)::float8` })
      .from(contacts)
      .where(where)
      .groupBy(contacts.stage),
    queryRows<{
      id: string;
      name: string;
      stage: Stage;
      grade: BoardCard["grade"];
      edapt_score: number | null;
      owner_id: string | null;
      owner_name: string | null;
      next_offer: string | null;
      ltv_inr: string | number;
      purchase_count: number;
      lost_reason: string | null;
    }>(sql`
      select r.id, r.name, r.stage, r.grade, r.edapt_score, r.owner_id, u.name as owner_name, r.next_offer, r.ltv_inr,
        r.purchase_count, r.lost_reason
      from (
        select ${contacts.id} as id, ${contacts.name} as name, ${contacts.stage} as stage, ${contacts.grade} as grade,
          ${contacts.edaptScore} as edapt_score, ${contacts.ownerId} as owner_id, ${contacts.nextOffer} as next_offer,
          ${contacts.ltvInr} as ltv_inr, ${contacts.purchaseCount} as purchase_count, ${contacts.lostReason} as lost_reason,
          row_number() over (
            partition by ${contacts.stage}
            order by ${contacts.edaptScore} desc nulls last, ${contacts.lastActivityAt} desc nulls last, ${contacts.id}
          ) as rn
        from ${contacts}
        where ${where}
      ) r
      left join users u on u.id = r.owner_id
      where r.rn <= ${per}
      order by r.stage, r.rn`, tx),
  ]);
  const byStage = new Map(totals.map((t) => [t.stage, t]));
  return BOARD_STAGES.map((stage) => ({
    stage,
    count: Number(byStage.get(stage)?.n ?? 0),
    ltvInr: Number(byStage.get(stage)?.ltv ?? 0),
    cards: cards
      .filter((c) => c.stage === stage)
      .map((c) => ({
        id: c.id,
        name: c.name,
        stage: c.stage,
        grade: c.grade,
        edaptScore: c.edapt_score === null ? null : Number(c.edapt_score),
        ownerId: c.owner_id,
        ownerName: c.owner_name,
        nextOffer: c.next_offer,
        ltvInr: Number(c.ltv_inr),
        purchaseCount: Number(c.purchase_count),
        lostReason: c.lost_reason,
      })),
  }));
}

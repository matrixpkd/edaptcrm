"use client";
/**
 * Dashboard charts (Recharts). Small client islands: the page passes plain rows, every chart has a table twin on
 * the page, so the tooltip only ever enhances. Marks follow the dataviz specs: bars at most 24px thick with 4px
 * rounded data-ends, 2px lines with 8px markers ringed in the surface colour, hairline solid grid, values at the
 * bar tips, text in ink tokens (never the series colour).
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatINR, formatINRCompact } from "@/lib/utils";
import { VIZ } from "./palette";

const TICK = { fill: VIZ.tick, fontSize: 12 };
const BAR = 10;
const ROW = 46;

type Series = { key: string; name: string; color: string; format: (v: number) => string };

/** One tooltip, every series: value first (strong), series name after, keyed by a short line in its colour. */
function ChartTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  label?: string | number;
  series: Series[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as Record<string, unknown> | undefined;
  return (
    <div className="min-w-40 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-foreground">{String(label ?? row?.label ?? "")}</p>
      <ul className="space-y-1">
        {series.map((s) => {
          const v = Number(row?.[s.key] ?? 0);
          return (
            <li key={s.key} className="flex items-center gap-2">
              <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
              <span className="tabular font-semibold text-foreground">{s.format(v)}</span>
              <span className="text-muted">{s.name}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Legend that mirrors the marks (rects for bars, lines for lines). Always shown for two or more series. */
export function ChartLegend({ items, shape = "rect" }: { items: { name: string; color: string }[]; shape?: "rect" | "line" }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
      {items.map((i) => (
        <li key={i.name} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={shape === "rect" ? "h-2.5 w-2.5 rounded-sm" : "h-0.5 w-3.5 rounded-full"}
            style={{ background: i.color }}
          />
          {i.name}
        </li>
      ))}
    </ul>
  );
}

function categoryWidth(labels: string[]): number {
  const longest = labels.reduce((m, l) => Math.max(m, l.length), 0);
  return Math.min(150, Math.max(64, Math.round(longest * 6.6) + 8));
}

// ---------------------------------------------------------------------------
// Revenue by family: current period (blue) against the previous period (context gray)
// ---------------------------------------------------------------------------

export type RevenueBarRow = { label: string; current: number; previous: number };

export function RevenueByFamilyChart({
  rows,
  currentName,
  previousName,
  ariaLabel,
}: {
  rows: RevenueBarRow[];
  currentName: string;
  previousName: string;
  ariaLabel: string;
}) {
  const series: Series[] = [
    { key: "current", name: currentName, color: VIZ.series1, format: formatINR },
    { key: "previous", name: previousName, color: VIZ.context, format: formatINR },
  ];
  const height = rows.length * ROW + 36;
  return (
    <div className="space-y-2">
      <ChartLegend items={[{ name: currentName, color: VIZ.series1 }, { name: previousName, color: VIZ.context }]} />
      <BarChart
        responsive
        layout="vertical"
        data={rows}
        style={{ width: "100%", height }}
        margin={{ top: 4, right: 56, bottom: 4, left: 0 }}
        barGap={2}
        barCategoryGap={10}
        title={ariaLabel}
      >
        <CartesianGrid horizontal={false} stroke={VIZ.grid} />
        <XAxis type="number" tick={TICK} tickFormatter={(v: number) => formatINRCompact(v)} axisLine={{ stroke: VIZ.axis }} tickLine={false} />
        <YAxis
          type="category"
          dataKey="label"
          width={categoryWidth(rows.map((r) => r.label))}
          tick={TICK}
          axisLine={{ stroke: VIZ.axis }}
          tickLine={false}
        />
        <Tooltip cursor={{ fill: "rgba(17,17,17,0.04)" }} content={(p) => <ChartTooltip active={p.active} payload={p.payload} label={p.label} series={series} />} />
        <Bar dataKey="current" name={currentName} fill={VIZ.series1} barSize={BAR} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          <LabelList dataKey="current" position="right" formatter={(v: unknown) => formatINRCompact(Number(v))} fill={VIZ.ink} fontSize={12} />
        </Bar>
        <Bar dataKey="previous" name={previousName} fill={VIZ.context} barSize={BAR} radius={[0, 4, 4, 0]} isAnimationActive={false} />
      </BarChart>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leads by channel: paid (blue) + not yet paid (gray) stacked, conversion at the tip
// ---------------------------------------------------------------------------

export type ChannelBarRow = { label: string; converted: number; open: number; leads: number; conversionText: string };

export function LeadsByChannelChart({ rows, ariaLabel }: { rows: ChannelBarRow[]; ariaLabel: string }) {
  const series: Series[] = [
    { key: "leads", name: "leads", color: "transparent", format: (v) => v.toLocaleString("en-IN") },
    { key: "converted", name: "paid", color: VIZ.series1, format: (v) => v.toLocaleString("en-IN") },
    { key: "open", name: "not paid yet", color: VIZ.context, format: (v) => v.toLocaleString("en-IN") },
  ];
  const height = rows.length * 38 + 36;
  return (
    <div className="space-y-2">
      <ChartLegend items={[{ name: "Paid", color: VIZ.series1 }, { name: "Not paid yet", color: VIZ.context }]} />
      <BarChart
        responsive
        layout="vertical"
        data={rows}
        style={{ width: "100%", height }}
        margin={{ top: 4, right: 48, bottom: 4, left: 0 }}
        barCategoryGap={8}
        title={ariaLabel}
      >
        <CartesianGrid horizontal={false} stroke={VIZ.grid} />
        <XAxis type="number" tick={TICK} allowDecimals={false} axisLine={{ stroke: VIZ.axis }} tickLine={false} />
        <YAxis type="category" dataKey="label" width={categoryWidth(rows.map((r) => r.label))} tick={TICK} axisLine={{ stroke: VIZ.axis }} tickLine={false} />
        <Tooltip cursor={{ fill: "rgba(17,17,17,0.04)" }} content={(p) => <ChartTooltip active={p.active} payload={p.payload} label={p.label} series={series} />} />
        <Bar dataKey="converted" stackId="leads" name="Paid" fill={VIZ.series1} barSize={14} stroke={VIZ.surface} strokeWidth={1} isAnimationActive={false} />
        <Bar dataKey="open" stackId="leads" name="Not paid yet" fill={VIZ.context} barSize={14} radius={[0, 4, 4, 0]} stroke={VIZ.surface} strokeWidth={1} isAnimationActive={false}>
          <LabelList dataKey="conversionText" position="right" fill={VIZ.ink} fontSize={12} />
        </Bar>
      </BarChart>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Average LTV by First Door: one series, value at the tip
// ---------------------------------------------------------------------------

export type DoorBarRow = { label: string; avg: number; customers: number };

export function LtvByDoorChart({ rows, ariaLabel }: { rows: DoorBarRow[]; ariaLabel: string }) {
  const series: Series[] = [
    { key: "avg", name: "average LTV", color: VIZ.series1, format: formatINR },
    { key: "customers", name: "customers", color: "transparent", format: (v) => v.toLocaleString("en-IN") },
  ];
  const height = rows.length * 34 + 36;
  return (
    <BarChart
      responsive
      layout="vertical"
      data={rows}
      style={{ width: "100%", height }}
      margin={{ top: 4, right: 56, bottom: 4, left: 0 }}
      barCategoryGap={8}
      title={ariaLabel}
    >
      <CartesianGrid horizontal={false} stroke={VIZ.grid} />
      <XAxis type="number" tick={TICK} tickFormatter={(v: number) => formatINRCompact(v)} axisLine={{ stroke: VIZ.axis }} tickLine={false} />
      <YAxis type="category" dataKey="label" width={categoryWidth(rows.map((r) => r.label))} tick={TICK} axisLine={{ stroke: VIZ.axis }} tickLine={false} />
      <Tooltip cursor={{ fill: "rgba(17,17,17,0.04)" }} content={(p) => <ChartTooltip active={p.active} payload={p.payload} label={p.label} series={series} />} />
      <Bar dataKey="avg" name="Average LTV" fill={VIZ.series1} barSize={12} radius={[0, 4, 4, 0]} isAnimationActive={false}>
        <LabelList dataKey="avg" position="right" formatter={(v: unknown) => formatINRCompact(Number(v))} fill={VIZ.ink} fontSize={12} />
      </Bar>
    </BarChart>
  );
}

// ---------------------------------------------------------------------------
// Beyond-Umer share by month: one 2px line, markers ringed in the surface colour, crosshair tooltip
// ---------------------------------------------------------------------------

export type ShareTrendRow = { label: string; share: number | null; rated: number; beyond: number };

export function ShareTrendChart({ rows, ariaLabel }: { rows: ShareTrendRow[]; ariaLabel: string }) {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const lastIndex = rows.reduce((i, r, idx) => (r.share !== null ? idx : i), -1);
  return (
    <LineChart
      responsive
      data={rows}
      style={{ width: "100%", height: 180 }}
      margin={{ top: 16, right: 40, bottom: 4, left: 0 }}
      title={ariaLabel}
    >
      <CartesianGrid vertical={false} stroke={VIZ.grid} />
      <XAxis dataKey="label" tick={TICK} axisLine={{ stroke: VIZ.axis }} tickLine={false} />
      <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={pct} tick={TICK} axisLine={false} tickLine={false} width={40} />
      <Tooltip
        cursor={{ stroke: VIZ.axis, strokeWidth: 1 }}
        content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null;
          const r = payload[0].payload as ShareTrendRow;
          return (
            <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
              <p className="mb-1 font-medium">{String(label)}</p>
              <p className="flex items-center gap-2">
                <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: VIZ.series1 }} />
                <span className="tabular font-semibold">{r.share === null ? "No rated revenue" : pct(r.share)}</span>
                <span className="text-muted">beyond Umer</span>
              </p>
              {r.share !== null && (
                <p className="mt-0.5 text-muted">
                  {formatINRCompact(r.beyond)} of {formatINRCompact(r.rated)} rated revenue
                </p>
              )}
            </div>
          );
        }}
      />
      <Line
        type="linear"
        dataKey="share"
        stroke={VIZ.series1}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        dot={{ r: 4, fill: VIZ.series1, stroke: VIZ.surface, strokeWidth: 2 }}
        activeDot={{ r: 5, fill: VIZ.series1, stroke: VIZ.surface, strokeWidth: 2 }}
        connectNulls={false}
        isAnimationActive={false}
      >
        <LabelList
          dataKey="share"
          position="top"
          content={(props) => {
            const { x, y, value, index } = props as { x?: number; y?: number; value?: number | null; index?: number };
            if (index !== lastIndex || value === null || value === undefined) return null;
            return (
              <text x={Number(x) + 8} y={Number(y) - 8} fill={VIZ.ink} fontSize={12} fontWeight={600}>
                {pct(value)}
              </text>
            );
          }}
        />
      </Line>
    </LineChart>
  );
}

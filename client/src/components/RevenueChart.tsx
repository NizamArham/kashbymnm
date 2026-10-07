import { useMemo, useState } from "react";

export interface RevenuePoint {
  label: string;
  value: number;
}

// Rounds a number up to a "nice" axis maximum (1/2/5 × a power of ten) so
// gridlines land on round figures instead of an arbitrary max-value split.
function niceCeiling(value: number): number {
  if (value <= 0) return 100;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function formatCompact(n: number): string {
  if (n < 0) return `-${formatCompact(-n)}`;
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

// A single-series revenue trend — thin line, light gradient fill anchored
// to the baseline, recessive gridlines, and a hover crosshair + tooltip
// (per dataviz guidance: line/area charts get interaction by default).
// No legend needed — there's only one series, and the card title names it.
export function RevenueChart({ data, height = 220 }: { data: RevenuePoint[]; height?: number }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 760;
  const padLeft = 46;
  const padRight = 14;
  const padTop = 16;
  const padBottom = 26;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const maxValue = useMemo(() => niceCeiling(Math.max(...data.map((d) => d.value), 1) * 1.15), [data]);
  // A day can net below zero (more handed back in returns than sold) — the axis
  // then gets room under its zero line.
  const minValue = useMemo(() => {
    const lowest = Math.min(...data.map((d) => d.value), 0);
    return lowest < 0 ? -niceCeiling(-lowest * 1.15) : 0;
  }, [data]);
  const gridLines = 4;
  const yOf = (value: number) => padTop + plotHeight * ((maxValue - value) / (maxValue - minValue));
  const zeroY = yOf(0);

  const points = useMemo(() => {
    if (data.length === 0) return [];
    const stepX = data.length > 1 ? plotWidth / (data.length - 1) : 0;
    return data.map((d, i) => ({
      x: padLeft + stepX * i,
      y: yOf(d.value),
      ...d,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, maxValue, minValue, plotWidth, plotHeight]);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${zeroY.toFixed(1)} L ${points[0].x.toFixed(1)} ${zeroY.toFixed(1)} Z`
      : "";

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    if (points.length === 0) return;
    const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0;
    const idx = stepX > 0 ? Math.round((relX - padLeft) / stepX) : 0;
    setHoverIndex(Math.max(0, Math.min(points.length - 1, idx)));
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#111827" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#111827" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Recessive gridlines + y-axis labels */}
        {[...(minValue < 0 ? [minValue] : []), ...Array.from({ length: gridLines + 1 }, (_, i) => (maxValue / gridLines) * i)].map((value, i) => {
          const y = yOf(value);
          return (
            <g key={i}>
              <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke={value === 0 && minValue < 0 ? "#D1D5DB" : "#F1F1F1"} strokeWidth={1} />
              <text x={padLeft - 8} y={y + 3} textAnchor="end" fontSize="10" fill="#9CA3AF">
                {formatCompact(value)}
              </text>
            </g>
          );
        })}

        {/* x-axis labels */}
        {points.map((p, i) => {
          const showEvery = points.length > 14 ? Math.ceil(points.length / 8) : 1;
          if (i % showEvery !== 0 && i !== points.length - 1) return null;
          return (
            <text key={i} x={p.x} y={height - 8} textAnchor="middle" fontSize="10" fill="#9CA3AF">
              {p.label}
            </text>
          );
        })}

        {areaPath && <path d={areaPath} fill="url(#revenueFill)" />}
        {linePath && <path d={linePath} fill="none" stroke="#111827" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}

        {hovered && (
          <>
            <line
              x1={hovered.x}
              y1={padTop}
              x2={hovered.x}
              y2={padTop + plotHeight}
              stroke="#9CA3AF"
              strokeWidth={1}
              strokeDasharray="3,3"
            />
            <circle cx={hovered.x} cy={hovered.y} r={4} fill="#111827" stroke="#fff" strokeWidth={2} />
          </>
        )}
      </svg>

      {hovered && (
        <div
          className="absolute pointer-events-none bg-gray-900 text-white text-xs font-medium px-2.5 py-1.5 rounded-lg shadow-lg whitespace-nowrap -translate-x-1/2"
          style={{
            left: `${(hovered.x / width) * 100}%`,
            top: `${Math.max(0, (hovered.y / height) * 100 - 14)}%`,
          }}
        >
          Rs. {hovered.value.toLocaleString()}
          <span className="block text-[10px] text-gray-400 font-normal">{hovered.label}</span>
        </div>
      )}
    </div>
  );
}

export interface RevenueProfitPoint {
  label: string;
  revenue: number;
  profit: number;
}

const REVENUE_COLOR = "#111827"; // gray-900 — matches the single-series chart above
const PROFIT_COLOR = "#059669"; // emerald-600 — distinct hue, reads as "growth" without clashing with the app's neutral palette

// Two-series version of the chart above — same axis, gridlines, and
// interaction model, but both Revenue and Profit share one y-axis (both
// are Rs. amounts, so a second axis would violate the "one axis" rule)
// and get a legend since there are now 2 series to tell apart.
export function RevenueProfitChart({ data, height = 260 }: { data: RevenueProfitPoint[]; height?: number }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 760;
  const padLeft = 50;
  const padRight = 14;
  const padTop = 16;
  const padBottom = 26;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const maxValue = useMemo(
    () => niceCeiling(Math.max(...data.map((d) => Math.max(d.revenue, d.profit)), 1) * 1.15),
    [data]
  );
  // A day can net below zero when what was returned or exchanged that day is
  // more than what was sold — the axis then gets room underneath its zero line.
  const minValue = useMemo(() => {
    const lowest = Math.min(...data.map((d) => Math.min(d.revenue, d.profit)), 0);
    return lowest < 0 ? -niceCeiling(-lowest * 1.15) : 0;
  }, [data]);
  const gridLines = 4;
  const yOf = (value: number) => padTop + plotHeight * ((maxValue - value) / (maxValue - minValue));

  const points = useMemo(() => {
    if (data.length === 0) return [];
    const stepX = data.length > 1 ? plotWidth / (data.length - 1) : 0;
    return data.map((d, i) => ({
      x: padLeft + stepX * i,
      yRevenue: yOf(d.revenue),
      yProfit: yOf(d.profit),
      ...d,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, maxValue, minValue, plotWidth, plotHeight]);

  const revenuePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.yRevenue.toFixed(1)}`).join(" ");
  const profitPath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.yProfit.toFixed(1)}`).join(" ");

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    if (points.length === 0) return;
    const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0;
    const idx = stepX > 0 ? Math.round((relX - padLeft) / stepX) : 0;
    setHoverIndex(Math.max(0, Math.min(points.length - 1, idx)));
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-2 px-1">
        <span className="flex items-center gap-1.5 text-xs text-gray-500">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: REVENUE_COLOR }} />
          Revenue
        </span>
        <span className="flex items-center gap-1.5 text-xs text-gray-500">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: PROFIT_COLOR }} />
          Profit
        </span>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          style={{ height }}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {[...(minValue < 0 ? [minValue] : []), ...Array.from({ length: gridLines + 1 }, (_, i) => (maxValue / gridLines) * i)].map((value, i) => {
            const y = yOf(value);
            return (
              <g key={i}>
                <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke={value === 0 && minValue < 0 ? "#D1D5DB" : "#F1F1F1"} strokeWidth={1} />
                <text x={padLeft - 8} y={y + 3} textAnchor="end" fontSize="10" fill="#9CA3AF">
                  {formatCompact(value)}
                </text>
              </g>
            );
          })}

          {points.map((p, i) => {
            const showEvery = points.length > 14 ? Math.ceil(points.length / 8) : 1;
            if (i % showEvery !== 0 && i !== points.length - 1) return null;
            return (
              <text key={i} x={p.x} y={height - 8} textAnchor="middle" fontSize="10" fill="#9CA3AF">
                {p.label}
              </text>
            );
          })}

          {revenuePath && <path d={revenuePath} fill="none" stroke={REVENUE_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {profitPath && <path d={profitPath} fill="none" stroke={PROFIT_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}

          {hovered && (
            <>
              <line
                x1={hovered.x}
                y1={padTop}
                x2={hovered.x}
                y2={padTop + plotHeight}
                stroke="#9CA3AF"
                strokeWidth={1}
                strokeDasharray="3,3"
              />
              <circle cx={hovered.x} cy={hovered.yRevenue} r={4} fill={REVENUE_COLOR} stroke="#fff" strokeWidth={2} />
              <circle cx={hovered.x} cy={hovered.yProfit} r={4} fill={PROFIT_COLOR} stroke="#fff" strokeWidth={2} />
            </>
          )}
        </svg>

        {hovered && (
          <div
            className="absolute pointer-events-none bg-gray-900 text-white text-xs font-medium px-2.5 py-1.5 rounded-lg shadow-lg whitespace-nowrap -translate-x-1/2"
            style={{
              left: `${(hovered.x / width) * 100}%`,
              top: `${Math.max(0, (Math.min(hovered.yRevenue, hovered.yProfit) / height) * 100 - 16)}%`,
            }}
          >
            <span style={{ color: "#34D399" }}>Profit Rs. {hovered.profit.toLocaleString()}</span>
            <span className="mx-1 text-gray-500">·</span>
            <span>Revenue Rs. {hovered.revenue.toLocaleString()}</span>
            <span className="block text-[10px] text-gray-400 font-normal">{hovered.label}</span>
          </div>
        )}
      </div>
    </div>
  );
}

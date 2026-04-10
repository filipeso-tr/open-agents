"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import useSWR from "swr";
import type { DateRange } from "react-day-picker";
import { ContributionChart } from "@/components/contribution-chart";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/hooks/use-session";
import { fetcher } from "@/lib/swr";
import { formatDateOnly } from "@/lib/usage/date-range";
import type { UsageInsights, UsageRepositoryInsight } from "@/lib/usage/types";
import { UsageInsightsSection } from "../usage/usage-insights-section";

// ── Types ──────────────────────────────────────────────────────────────────

interface DailyUsageRow {
  date: string;
  source: "web";
  agentType: "main" | "subagent";
  provider: string | null;
  modelId: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  messageCount: number;
  toolCallCount: number;
}

interface MergedDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  toolCallCount: number;
}

interface ModelUsage {
  modelId: string;
  provider: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  messageCount: number;
  toolCallCount: number;
}

interface PieSegment {
  label: string;
  value: number;
  color: string;
  detail?: string;
}

interface UsageResponse {
  usage: DailyUsageRow[];
  insights: UsageInsights;
  domainLeaderboard: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTokens(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function sumRows(rows: DailyUsageRow[]) {
  return rows.reduce(
    (acc, d) => ({
      inputTokens: acc.inputTokens + d.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + d.cachedInputTokens,
      outputTokens: acc.outputTokens + d.outputTokens,
      messageCount: acc.messageCount + d.messageCount,
      toolCallCount: acc.toolCallCount + d.toolCallCount,
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      messageCount: 0,
      toolCallCount: 0,
    },
  );
}

function mergeDays(rows: DailyUsageRow[]): MergedDay[] {
  const map = new Map<string, MergedDay>();
  for (const r of rows) {
    const existing = map.get(r.date);
    if (existing) {
      existing.inputTokens += r.inputTokens;
      existing.outputTokens += r.outputTokens;
      existing.messageCount += r.messageCount;
      existing.toolCallCount += r.toolCallCount;
    } else {
      map.set(r.date, {
        date: r.date,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        messageCount: r.messageCount,
        toolCallCount: r.toolCallCount,
      });
    }
  }
  return [...map.values()];
}

function aggregateByModel(rows: DailyUsageRow[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const r of rows) {
    if (!r.modelId) continue;
    const existing = map.get(r.modelId);
    if (existing) {
      existing.inputTokens += r.inputTokens;
      existing.cachedInputTokens += r.cachedInputTokens;
      existing.outputTokens += r.outputTokens;
      existing.messageCount += r.messageCount;
      existing.toolCallCount += r.toolCallCount;
    } else {
      map.set(r.modelId, {
        modelId: r.modelId,
        provider: r.provider ?? "unknown",
        inputTokens: r.inputTokens,
        cachedInputTokens: r.cachedInputTokens,
        outputTokens: r.outputTokens,
        messageCount: r.messageCount,
        toolCallCount: r.toolCallCount,
      });
    }
  }
  return [...map.values()].toSorted(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
}

function displayModelId(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  return slashIndex >= 0 ? modelId.slice(slashIndex + 1) : modelId;
}

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number,
) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function buildPieSegment(
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  endAngle: number,
) {
  const startOuter = polarToCartesian(centerX, centerY, radius, endAngle);
  const endOuter = polarToCartesian(centerX, centerY, radius, startAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return [
    `M ${centerX} ${centerY}`,
    `L ${startOuter.x} ${startOuter.y}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} 0 ${endOuter.x} ${endOuter.y}`,
    "Z",
  ].join(" ");
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold font-mono tabular-nums">
        {value}
      </span>
    </div>
  );
}

function UsagePieChart({
  segments,
  centerLabel,
  emptyLabel,
}: {
  segments: PieSegment[];
  centerLabel: string;
  emptyLabel: string;
}) {
  const visibleSegments = segments.filter((s) => s.value > 0);
  const total = visibleSegments.reduce((sum, s) => sum + s.value, 0);
  const [hoveredSegment, setHoveredSegment] = useState<PieSegment | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const size = 120;
  const center = size / 2;
  const radius = 60;
  let currentAngle = 0;
  const singleSegment =
    visibleSegments.length === 1 ? visibleSegments[0] : undefined;

  return (
    <div className="grid gap-4 md:grid-cols-[120px,1fr]">
      <div className="relative mx-auto h-28 w-28">
        <div className="absolute inset-0 rounded-full ring-1 ring-border" />
        {visibleSegments.length === 0 ? (
          <div className="absolute inset-0 rounded-full bg-muted" />
        ) : (
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox={`0 0 ${size} ${size}`}
            role="img"
            aria-label={centerLabel}
          >
            {singleSegment ? (
              <circle
                cx={center}
                cy={center}
                r={radius}
                fill={singleSegment.color}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredSegment(singleSegment)}
                onMouseLeave={() => setHoveredSegment(null)}
                onMouseMove={(event) => {
                  const svg = event.currentTarget.ownerSVGElement;
                  const rect = svg ? svg.getBoundingClientRect() : null;
                  if (!rect) return;
                  setTooltipPosition({
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top,
                  });
                }}
              />
            ) : (
              visibleSegments.map((segment) => {
                const startAngle = currentAngle;
                const angle = (segment.value / total) * 360;
                const endAngle = startAngle + angle;
                currentAngle = endAngle;
                const path = buildPieSegment(
                  center,
                  center,
                  radius,
                  startAngle,
                  endAngle,
                );
                return (
                  <path
                    key={segment.label}
                    d={path}
                    fill={segment.color}
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredSegment(segment)}
                    onMouseLeave={() => setHoveredSegment(null)}
                    onMouseMove={(event) => {
                      const svg = event.currentTarget.ownerSVGElement;
                      const rect = svg ? svg.getBoundingClientRect() : null;
                      if (!rect) return;
                      setTooltipPosition({
                        x: event.clientX - rect.left,
                        y: event.clientY - rect.top,
                      });
                    }}
                  />
                );
              })
            )}
          </svg>
        )}
        {hoveredSegment ? (
          <div
            className="pointer-events-none absolute z-10 w-fit whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm"
            style={{
              left: Math.min(tooltipPosition.x + 12, size - 8),
              top: Math.min(tooltipPosition.y + 12, size - 8),
            }}
          >
            <div className="font-medium">{hoveredSegment.label}</div>
            <div className="font-mono">
              {formatTokens(hoveredSegment.value)} tokens
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        {visibleSegments.length === 0 ? (
          <div className="text-sm text-muted-foreground">{emptyLabel}</div>
        ) : (
          visibleSegments.map((segment) => {
            const share =
              total > 0 ? Math.round((segment.value / total) * 100) : 0;
            return (
              <div
                key={segment.label}
                className="flex items-center gap-2 text-sm"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: segment.color }}
                />
                <span className="min-w-0 truncate font-medium">
                  {segment.label}
                </span>
                <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {formatTokens(segment.value)} ({share}%)
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Top repos for sidebar ──────────────────────────────────────────────────

function TopRepos({ repos }: { repos: UsageRepositoryInsight[] }) {
  const top3 = repos.slice(0, 3);
  if (top3.length === 0) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Top repositories
      </h3>
      <div className="space-y-2">
        {top3.map((repo) => (
          <div
            key={`${repo.repoOwner}/${repo.repoName}`}
            className="rounded-lg border border-border/50 bg-muted/10 px-3 py-2"
          >
            <p className="truncate text-sm font-medium">
              {repo.repoOwner}/{repo.repoName}
            </p>
            <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">
                {repo.sessionCount.toLocaleString()} sessions
              </span>
              <span className="font-mono tabular-nums">
                {repo.totalLinesChanged.toLocaleString()} lines
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Profile sidebar (left column) ──────────────────────────────────────────

function ProfileSidebar({
  totals,
  topRepos,
}: {
  totals: {
    inputTokens: number;
    outputTokens: number;
    messageCount: number;
    toolCallCount: number;
  } | null;
  topRepos: UsageRepositoryInsight[] | null;
}) {
  const { session, loading } = useSession();

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-14 w-14 shrink-0 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
    );
  }

  if (!session?.user) return null;

  const totalTokens = totals
    ? totals.inputTokens + totals.outputTokens
    : 0;

  return (
    <div className="space-y-5">
      {/* Avatar + name — left-aligned */}
      <div className="flex items-center gap-3">
        {session.user.avatar && (
          <Image
            src={session.user.avatar}
            alt={session.user.username}
            width={56}
            height={56}
            className="shrink-0 rounded-full"
          />
        )}
        <div className="min-w-0">
          <p className="truncate text-base font-semibold leading-tight">
            {session.user.name ?? session.user.username}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            @{session.user.username}
          </p>
        </div>
      </div>

      {/* Email */}
      {session.user.email && (
        <p className="truncate text-sm text-muted-foreground">
          {session.user.email}
        </p>
      )}

      {/* Stats */}
      {totals && (
        <div className="rounded-lg border border-border/50 bg-muted/10 px-4 py-1 divide-y divide-border/50">
          <StatItem label="Total tokens" value={formatTokens(totalTokens)} />
          <StatItem
            label="Messages"
            value={totals.messageCount.toLocaleString()}
          />
          <StatItem
            label="Tool calls"
            value={totals.toolCallCount.toLocaleString()}
          />
        </div>
      )}

      {/* Top repos */}
      {topRepos && <TopRepos repos={topRepos} />}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);

  const filteredUsagePath = useMemo(() => {
    if (!dateRange?.from) return null;
    const from = formatDateOnly(dateRange.from);
    const to = formatDateOnly(dateRange.to ?? dateRange.from);
    const query = new URLSearchParams({ from, to });
    return `/api/usage?${query.toString()}`;
  }, [dateRange]);

  const {
    data: fullData,
    isLoading: isFullDataLoading,
    error: fullDataError,
  } = useSWR<UsageResponse>("/api/usage", fetcher);
  const {
    data: filteredData,
    isLoading: isFilteredDataLoading,
    error: filteredDataError,
  } = useSWR<UsageResponse>(filteredUsagePath, fetcher);

  const data = filteredUsagePath ? filteredData : fullData;
  const isLoading =
    isFullDataLoading || (filteredUsagePath !== null && isFilteredDataLoading);
  const error = fullDataError ?? filteredDataError;

  const { totals, chartData, modelUsage, mainTotals, subagentTotals } =
    useMemo(() => {
      const selectedUsage = data?.usage ?? [];
      const chartUsage = fullData?.usage ?? selectedUsage;
      const main = selectedUsage.filter((r) => r.agentType === "main");
      const subagent = selectedUsage.filter((r) => r.agentType === "subagent");
      return {
        totals: sumRows(selectedUsage),
        chartData: mergeDays(chartUsage),
        modelUsage: aggregateByModel(selectedUsage),
        mainTotals: sumRows(main),
        subagentTotals: sumRows(subagent),
      };
    }, [data, fullData]);

  const mainTokens = mainTotals.inputTokens + mainTotals.outputTokens;
  const subagentTokens = subagentTotals.inputTokens + subagentTotals.outputTokens;
  const hasUsage = totals.messageCount > 0;

  const agentSegments: PieSegment[] = [
    {
      label: "Main agent",
      value: mainTokens,
      color: CHART_COLORS[0] ?? "var(--chart-1)",
    },
    {
      label: "Subagents",
      value: subagentTokens,
      color: CHART_COLORS[1] ?? "var(--chart-2)",
    },
  ];

  const modelSegments = (() => {
    const totalsByModel = modelUsage.map((m) => ({
      modelId: m.modelId,
      provider: m.provider,
      totalTokens: m.inputTokens + m.outputTokens,
    }));
    const topModels = totalsByModel
      .filter((m) => m.totalTokens > 0)
      .slice(0, 5);
    const otherTotal = totalsByModel
      .slice(5)
      .reduce((sum, m) => sum + m.totalTokens, 0);
    const segments: PieSegment[] = topModels.map((m, index) => ({
      label: displayModelId(m.modelId),
      value: m.totalTokens,
      color: CHART_COLORS[index % CHART_COLORS.length] ?? "var(--chart-1)",
    }));
    if (otherTotal > 0) {
      segments.push({
        label: "Other",
        value: otherTotal,
        color: "var(--muted-foreground)",
      });
    }
    return segments;
  })();

  const dateRangeLabel = dateRange?.from
    ? (() => {
        const fromLabel = dateRange.from.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const toDate = dateRange.to ?? dateRange.from;
        const toLabel = toDate.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return fromLabel === toLabel
          ? `Activity for ${fromLabel}`
          : `${fromLabel} – ${toLabel}`;
      })()
    : null;

  const topRepos = data?.insights?.topRepositories ?? null;

  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
      {/* Left sidebar */}
      <div className="w-full shrink-0 lg:w-56">
        <ProfileSidebar
          totals={isLoading ? null : totals}
          topRepos={isLoading ? null : topRepos}
        />
      </div>

      {/* Right content */}
      <div className="min-w-0 flex-1 space-y-6">
        {/* Activity grid */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              Activity
            </h2>
            {dateRangeLabel && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-0 py-0 text-xs text-muted-foreground"
                onClick={() => setDateRange(undefined)}
              >
                {dateRangeLabel} · Clear
              </Button>
            )}
          </div>
          {isLoading ? (
            <Skeleton className="h-[96px] w-full rounded-md" />
          ) : (
            <ContributionChart
              data={chartData}
              selectedRange={dateRange}
              onSelectRange={setDateRange}
            />
          )}
        </div>

        {/* Usage breakdown */}
        {isLoading ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-36 rounded-xl" />
            <Skeleton className="h-36 rounded-xl" />
          </div>
        ) : error ? (
          <p className="text-sm text-muted-foreground">
            Failed to load usage data.
          </p>
        ) : (
          <>
            {/* Pie charts */}
            {(hasUsage || modelUsage.length > 0) && (
              <div className="grid gap-6 lg:grid-cols-2">
                {hasUsage && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Agent split</h3>
                    <UsagePieChart
                      segments={agentSegments}
                      centerLabel="Total tokens"
                      emptyLabel="No agent usage"
                    />
                  </div>
                )}
                {modelUsage.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Usage by model</h3>
                    <UsagePieChart
                      segments={modelSegments}
                      centerLabel="Total tokens"
                      emptyLabel="No model usage"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Insights */}
            {data?.insights ? (
              <UsageInsightsSection insights={data.insights} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

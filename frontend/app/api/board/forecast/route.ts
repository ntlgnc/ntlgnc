import { NextResponse } from "next/server";
import { Client } from "pg";

export const dynamic = "force-dynamic";

/* ── Exact one-sided binomial p-value: P(X >= k | n, p=0.5) ── */
function binomialPValue(k: number, n: number, p = 0.5): number {
  if (n === 0 || k <= 0) return 1;
  if (k > n) return 0;
  // Use log-space for numerical stability
  function logChoose(n: number, k: number): number {
    if (k < 0 || k > n) return -Infinity;
    if (k === 0 || k === n) return 0;
    let s = 0;
    for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1);
    return s;
  }
  // P(X >= k) = 1 - P(X <= k-1) = 1 - sum_{i=0}^{k-1} C(n,i) * p^i * (1-p)^(n-i)
  let cdf = 0;
  for (let i = 0; i < k; i++) {
    cdf += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

export async function GET() {
  const conn = process.env.DATABASE_URL;
  if (!conn) return NextResponse.json({ error: "DATABASE_URL not set" }, { status: 500 });

  const client = new Client({ connectionString: conn });
  await client.connect();

  try {
    // Fetch ALL forecasts for comprehensive stats
    const { rows: allForecasts } = await client.query(`
      SELECT id, round_number, btc_price_at_forecast, btc_price_at_review,
             actual_direction, actual_change_pct, consensus_direction,
             consensus_correct, individual_forecasts, individual_scores,
             group_vote_direction, group_vote_details,
             phase1_analyses, chair_summary, deliberation, process_proposals,
             created_at, reviewed_at
      FROM board_btc_forecasts
      ORDER BY created_at DESC
    `);

    const reviewed = allForecasts.filter((r) => r.reviewed_at);
    const correct = reviewed.filter((r) => r.consensus_correct).length;

    // Base rate: what % of rounds BTC actually went UP
    const totalUp = reviewed.filter((r) => r.actual_direction === "UP").length;
    const baseRate = reviewed.length > 0 ? totalUp / reviewed.length : 0.5;

    // Consensus p-value
    const consensusPValue = binomialPValue(correct, reviewed.length);

    // Group vote stats
    const reviewedWithGroupVote = reviewed.filter((r) => r.group_vote_direction);
    const groupVoteCorrect = reviewedWithGroupVote.filter(
      (r) => r.group_vote_direction === r.actual_direction
    ).length;
    const groupVotePValue = binomialPValue(groupVoteCorrect, reviewedWithGroupVote.length);

    // Per-LLM leaderboard with p-values + group vote stats
    let leaderboard: any[] = [];
    try {
      const { rows } = await client.query(`
        SELECT member_id, total_forecasts, correct_direction, total_abs_error,
               current_streak, best_streak, last_updated,
               COALESCE(group_vote_correct, 0) as group_vote_correct
        FROM board_forecast_leaderboard
        ORDER BY CASE WHEN total_forecasts = 0 THEN 0
                      ELSE correct_direction::float / total_forecasts END DESC
      `);
      leaderboard = rows.map(r => {
        const n = r.total_forecasts || 0;
        const k = r.correct_direction || 0;
        const accuracy = n > 0 ? (k / n) * 100 : 0;
        const pValue = binomialPValue(k, n);
        const gvk = r.group_vote_correct || 0;
        const gvAccuracy = n > 0 ? (gvk / n) * 100 : 0;
        const gvPValue = binomialPValue(gvk, n);
        return {
          ...r,
          accuracy: accuracy.toFixed(1),
          avg_error: n > 0 ? (r.total_abs_error / n).toFixed(2) : null,
          p_value: +pValue.toFixed(4),
          significant: pValue < 0.05,
          excess: +(accuracy - baseRate * 100).toFixed(1),
          group_vote_accuracy: gvAccuracy.toFixed(1),
          group_vote_p_value: +gvPValue.toFixed(4),
        };
      });
    } catch {}

    // Return last 50 forecast rows for UI (direction tape + charts)
    const recentForecasts = allForecasts.slice(0, 50);

    // Build compact chart data from ALL scored forecasts (oldest first) for cumulative returns
    const chartData = [...reviewed].reverse().map((f) => {
      const indiv = typeof f.individual_forecasts === "string" ? JSON.parse(f.individual_forecasts) : f.individual_forecasts;
      const changePct = f.actual_change_pct ?? 0;
      const dirs: Record<string, string> = {};
      for (const id of ["claude", "gpt", "grok", "gemini", "deepseek"]) {
        dirs[id] = indiv?.[id]?.direction || "";
      }
      return {
        round: f.round_number,
        time: f.created_at,
        changePct: +changePct,
        consensusDir: f.consensus_direction,
        groupVoteDir: f.group_vote_direction || "",
        dirs,
      };
    });

    return NextResponse.json({
      forecasts: recentForecasts,
      chartData,
      trackRecord: {
        total: reviewed.length,
        correct,
        accuracy: reviewed.length > 0 ? ((correct / reviewed.length) * 100).toFixed(1) : "0",
        p_value: +consensusPValue.toFixed(4),
        group_vote_total: reviewedWithGroupVote.length,
        group_vote_correct: groupVoteCorrect,
        group_vote_accuracy: reviewedWithGroupVote.length > 0
          ? ((groupVoteCorrect / reviewedWithGroupVote.length) * 100).toFixed(1)
          : "0",
        group_vote_p_value: +groupVotePValue.toFixed(4),
      },
      leaderboard,
      baseRate: +(baseRate * 100).toFixed(1),
      significanceThreshold: 0.05,
      latest: allForecasts[0] || null,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    await client.end();
  }
}

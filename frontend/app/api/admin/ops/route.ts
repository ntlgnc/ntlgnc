import { NextRequest, NextResponse } from "next/server";
import { Client } from "pg";
import { validateAdminRequest, unauthorizedResponse } from "@/lib/admin-auth";

const DB_URL = process.env.DATABASE_URL;

async function getClient() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  return client;
}

export async function GET(req: NextRequest) {
  if (!validateAdminRequest(req)) return unauthorizedResponse();
  if (!DB_URL) return NextResponse.json({ error: "No DATABASE_URL" }, { status: 500 });

  const client = await getClient();
  try {
    // Gather stats
    const [predictions, comments, candles, users, signals, strategies] = await Promise.all([
      client.query('SELECT COUNT(*) as count, MIN(timestamp) as earliest, MAX(timestamp) as latest FROM "Prediction"').catch(() => ({ rows: [{ count: 0, earliest: null, latest: null }] })),
      client.query('SELECT COUNT(*) as count FROM "BotComment"').catch(() => ({ rows: [{ count: 0 }] })),
      client.query('SELECT COUNT(*) as count, MIN(timestamp) as earliest, MAX(timestamp) as latest FROM "Candle1m"').catch(() => ({ rows: [{ count: 0, earliest: null, latest: null }] })),
      client.query('SELECT COUNT(*) as count FROM "User"').catch(() => ({ rows: [{ count: 0 }] })),
      client.query('SELECT COUNT(*) as count FROM "Signal"').catch(() => ({ rows: [{ count: 0 }] })),
      client.query('SELECT COUNT(*) as count FROM "Strategy"').catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    // Bull rate
    let bullRate = null;
    try {
      const br = await client.query(`
        SELECT 
          COUNT(*) FILTER (WHERE direction = 'up') as bulls,
          COUNT(*) FILTER (WHERE direction = 'down') as bears,
          COUNT(*) as total
        FROM "Prediction"
        WHERE timestamp > NOW() - INTERVAL '6 hours'
      `);
      const r = br.rows[0];
      if (r.total > 0) {
        bullRate = { bulls: parseInt(r.bulls), bears: parseInt(r.bears), total: parseInt(r.total), pct: ((r.bulls / r.total) * 100).toFixed(1) };
      }
    } catch {}

    // Per-model bull rate (last 6h)
    let modelBullRates = [];
    try {
      const mbr = await client.query(`
        SELECT provider,
          COUNT(*) FILTER (WHERE direction = 'up') as bulls,
          COUNT(*) as total
        FROM "Prediction"
        WHERE timestamp > NOW() - INTERVAL '6 hours'
        GROUP BY provider
        ORDER BY provider
      `);
      modelBullRates = mbr.rows.map(r => ({
        provider: r.provider,
        bulls: parseInt(r.bulls),
        total: parseInt(r.total),
        pct: ((r.bulls / r.total) * 100).toFixed(1),
      }));
    } catch {}

    return NextResponse.json({
      predictions: predictions.rows[0],
      comments: comments.rows[0],
      candles: candles.rows[0],
      users: users.rows[0],
      signals: signals.rows[0],
      strategies: strategies.rows[0],
      bullRate,
      modelBullRates,
      ...(await getScoringHealth(client)),
      ...(await getEngineHealth(client)),
    });
  } finally {
    await client.end();
  }
}

/* ═══ Scoring Health ═══ */
async function getScoringHealth(client: any) {
  try {
    const [backlog, latestScored, latestCandle, latestPred, hourly] = await Promise.all([
      client.query(`SELECT COUNT(*)::int AS n FROM "Prediction" WHERE "actualClose" IS NULL AND timestamp + ("horizonMinutes" * interval '1 minute') < NOW()`),
      client.query(`SELECT MAX("scoredAt") AS ts FROM "Prediction" WHERE "actualClose" IS NOT NULL`),
      client.query(`SELECT MAX(timestamp) AS ts FROM "Candle1m"`),
      client.query(`SELECT MAX(timestamp) AS ts FROM "Prediction"`),
      // Hourly throughput for the last 24 hours
      client.query(`
        SELECT
          date_trunc('hour', "scoredAt") AS hour,
          COUNT(*)::int AS scored,
          COUNT(*) FILTER (WHERE correct = true)::int AS wins,
          ROUND(AVG("returnPercent")::numeric, 4) AS avg_ret
        FROM "Prediction"
        WHERE "scoredAt" > NOW() - INTERVAL '24 hours'
          AND "scoredAt" IS NOT NULL
        GROUP BY date_trunc('hour', "scoredAt")
        ORDER BY hour ASC
      `),
    ]);

    // Per-model throughput (last 1 hour)
    const modelThroughput = await client.query(`
      SELECT provider,
        COUNT(*)::int AS predictions,
        COUNT(*) FILTER (WHERE "actualClose" IS NOT NULL)::int AS scored,
        COUNT(*) FILTER (WHERE correct = true)::int AS wins
      FROM "Prediction"
      WHERE timestamp > NOW() - INTERVAL '1 hour'
      GROUP BY provider ORDER BY provider
    `);

    return {
      scoringHealth: {
        backlog: backlog.rows[0]?.n || 0,
        latestScored: latestScored.rows[0]?.ts || null,
        latestCandle: latestCandle.rows[0]?.ts || null,
        latestPrediction: latestPred.rows[0]?.ts || null,
        hourly: hourly.rows.map((r: any) => ({
          hour: r.hour,
          scored: r.scored,
          wins: r.wins,
          avgRet: parseFloat(r.avg_ret || 0),
          winPct: r.scored > 0 ? Math.round((r.wins / r.scored) * 100) : 0,
        })),
        modelThroughput: modelThroughput.rows,
      },
    };
  } catch (err: any) {
    console.warn('[admin/ops] Scoring health query failed:', err.message?.slice(0, 100));
    return { scoringHealth: null };
  }
}

/* ═══ Engine Health ═══ */
async function getEngineHealth(client: any) {
  try {
    const [modelFreshness, cycleSlots, freshnessSummary] = await Promise.all([
      // Per-model prediction count + age (last 30 min)
      client.query(`
        SELECT provider,
          COUNT(*)::int AS preds,
          TO_CHAR(MAX(timestamp), 'HH24:MI:SS') AS latest,
          ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) / 60, 1)::float AS age_m
        FROM "Prediction"
        WHERE timestamp > NOW() - INTERVAL '30 minutes'
        GROUP BY provider ORDER BY age_m
      `),
      // Predictions per 5-min window (last 1 hour)
      client.query(`
        SELECT
          TO_CHAR(to_timestamp(floor(extract(epoch FROM timestamp) / 300) * 300), 'HH24:MI') AS slot,
          COUNT(*)::int AS preds,
          COUNT(DISTINCT provider)::int AS models
        FROM "Prediction"
        WHERE timestamp > NOW() - INTERVAL '1 hour'
        GROUP BY slot ORDER BY slot DESC LIMIT 12
      `),
      // Overall freshness
      client.query(`
        SELECT
          ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) / 60, 1)::float AS newest_m,
          COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '5 minutes')::int AS last_5m,
          COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '1 hour')::int AS last_1h
        FROM "Prediction" WHERE timestamp > NOW() - INTERVAL '2 hours'
      `),
    ]);

    const slots = cycleSlots.rows;
    const totalPreds = slots.reduce((s: number, r: any) => s + r.preds, 0);
    const avgPerSlot = slots.length > 0 ? Math.round(totalPreds / slots.length) : 0;

    return {
      engineHealth: {
        modelFreshness: modelFreshness.rows,
        cycleSlots: slots,
        avgPerSlot,
        newest_m: freshnessSummary.rows[0]?.newest_m ?? null,
        last_5m: freshnessSummary.rows[0]?.last_5m ?? 0,
        last_1h: freshnessSummary.rows[0]?.last_1h ?? 0,
      },
    };
  } catch (err: any) {
    console.warn('[admin/ops] Engine health query failed:', err.message?.slice(0, 100));
    return { engineHealth: null };
  }
}

export async function POST(req: NextRequest) {
  if (!validateAdminRequest(req)) return unauthorizedResponse();
  if (!DB_URL) return NextResponse.json({ error: "No DATABASE_URL" }, { status: 500 });

  const { action } = await req.json();
  const client = await getClient();

  try {
    switch (action) {
      case "clear_predictions":
        await client.query('TRUNCATE "Prediction" CASCADE');
        await client.query('TRUNCATE "BotComment" CASCADE');
        return NextResponse.json({ ok: true, message: "Predictions and comments cleared" });

      case "clear_comments":
        await client.query('TRUNCATE "BotComment" CASCADE');
        return NextResponse.json({ ok: true, message: "Comments cleared (predictions preserved)" });

      case "clear_signals":
        await client.query('TRUNCATE "Signal" CASCADE');
        await client.query('TRUNCATE "SignalScore" CASCADE');
        return NextResponse.json({ ok: true, message: "Signals and scores cleared" });

      case "clear_feeds":
        await client.query('TRUNCATE "FeedConfig" CASCADE');
        await client.query('TRUNCATE "Signal" CASCADE');
        await client.query('TRUNCATE "SignalScore" CASCADE');
        return NextResponse.json({ ok: true, message: "Feed configs, signals and scores cleared" });

      case "clear_strategies":
        try { await client.query('TRUNCATE "StrategySignal" CASCADE'); } catch {}
        await client.query('TRUNCATE "Strategy" CASCADE');
        return NextResponse.json({ ok: true, message: "Strategies and strategy signals cleared" });

      case "clear_all":
        await client.query('TRUNCATE "Prediction" CASCADE');
        await client.query('TRUNCATE "BotComment" CASCADE');
        try { await client.query('TRUNCATE "Signal" CASCADE'); } catch {}
        try { await client.query('TRUNCATE "SignalScore" CASCADE'); } catch {}
        try { await client.query('TRUNCATE "FeedConfig" CASCADE'); } catch {}
        try { await client.query('TRUNCATE "StrategySignal" CASCADE'); } catch {}
        try { await client.query('TRUNCATE "Strategy" CASCADE'); } catch {}
        try { await client.query('TRUNCATE "ModelBiasTracker" CASCADE'); } catch {}
        return NextResponse.json({ ok: true, message: "All data cleared (candles preserved)" });

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } finally {
    await client.end();
  }
}

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — Board API Endpoints (v3)                              ║
 * ║                                                                  ║
 * ║  Provides REST endpoints for the frontend to consume:            ║
 * ║    GET  /api/board/hero      — Active hero content               ║
 * ║    POST /api/board/feedback  — Submit thumbs up/down             ║
 * ║    GET  /api/board/forecast  — Latest BTC forecast + history     ║
 * ║    GET  /api/board/competition — Competition leaderboard         ║
 * ║    GET  /api/board/meetings  — Recent meeting summaries          ║
 * ║                                                                  ║
 * ║  Usage: Import these handlers into your Next.js API routes       ║
 * ║  or run standalone with: node backend/board-api.js               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// ═══════════════════════════════════════════════════════════════
// GET /api/board/hero — Returns active hero content
// ═══════════════════════════════════════════════════════════════

export async function getHeroContent() {
  const client = await pool.connect();
  try {
    // Increment impressions
    await client.query(`UPDATE board_hero_content SET impressions = impressions + 1 WHERE active = true`);
    
    const { rows } = await client.query(`
      SELECT id, authored_by, badge_text, headline, subheadline, body_text,
             cta_left, cta_right, thumbs_up, thumbs_down, impressions, created_at
      FROM board_hero_content WHERE active = true
      ORDER BY created_at DESC LIMIT 1
    `);
    
    if (rows.length === 0) {
      // Return default hero content
      return {
        id: 0,
        authored_by: 'system',
        badge_text: 'LIVE — Signals firing now',
        headline: 'Recursive AI Alpha',
        subheadline: 'Humans built it. The machines took it from here.',
        body_text: 'Five frontier AI models meet every hour to debate, test, and deploy strategy improvements. No human approves the changes. The system gets better on its own. Watch the performance curve.',
        cta_left: 'View Live Signals',
        cta_right: 'See the Evidence',
        thumbs_up: 0,
        thumbs_down: 0,
        impressions: 0,
      };
    }
    
    return rows[0];
  } finally {
    client.release();
  }
}


// ═══════════════════════════════════════════════════════════════
// GET /api/board/hero/history — Hero content history with feedback
// ═══════════════════════════════════════════════════════════════

export async function getHeroHistory() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, authored_by, headline, subheadline, thumbs_up, thumbs_down,
             impressions, active, created_at
      FROM board_hero_content ORDER BY created_at DESC LIMIT 10
    `);
    return rows;
  } finally {
    client.release();
  }
}


// ═══════════════════════════════════════════════════════════════
// POST /api/board/feedback — Submit thumbs up/down
// Body: { feature_type: 'hero'|'filter'|..., feature_id: 123, vote: 'up'|'down', session_id?: '...' }
// ═══════════════════════════════════════════════════════════════

export async function submitFeedback({ feature_type, feature_id, vote, session_id, ip_hash }) {
  if (!feature_type || !feature_id || !['up', 'down'].includes(vote)) {
    throw new Error('Invalid feedback: need feature_type, feature_id, and vote (up/down)');
  }
  
  const client = await pool.connect();
  try {
    // Check for duplicate votes (same session + same feature)
    if (session_id) {
      const { rows: existing } = await client.query(
        `SELECT id FROM user_feedback WHERE feature_type = $1 AND feature_id = $2 AND session_id = $3`,
        [feature_type, feature_id, session_id]
      );
      if (existing.length > 0) {
        // Update existing vote
        await client.query(
          `UPDATE user_feedback SET vote = $1, created_at = now() WHERE id = $2`,
          [vote, existing[0].id]
        );
        // Update aggregate on the feature
        await updateFeedbackAggregates(client, feature_type, feature_id);
        return { updated: true, id: existing[0].id };
      }
    }
    
    // Insert new feedback
    const { rows: [inserted] } = await client.query(
      `INSERT INTO user_feedback (feature_type, feature_id, vote, session_id, ip_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [feature_type, feature_id, vote, session_id || null, ip_hash || null]
    );
    
    // Update aggregates
    await updateFeedbackAggregates(client, feature_type, feature_id);
    
    return { created: true, id: inserted.id };
  } finally {
    client.release();
  }
}

async function updateFeedbackAggregates(client, featureType, featureId) {
  const { rows: [counts] } = await client.query(`
    SELECT 
      COUNT(*) FILTER (WHERE vote = 'up')::int as ups,
      COUNT(*) FILTER (WHERE vote = 'down')::int as downs
    FROM user_feedback WHERE feature_type = $1 AND feature_id = $2
  `, [featureType, featureId]);
  
  // Update the relevant table
  if (featureType === 'hero') {
    await client.query(
      `UPDATE board_hero_content SET thumbs_up = $1, thumbs_down = $2 WHERE id = $3`,
      [counts.ups, counts.downs, featureId]
    );
  }
  // Add more feature types here as needed
}


// ═══════════════════════════════════════════════════════════════
// GET /api/board/forecast — BTC forecast data
// ═══════════════════════════════════════════════════════════════

export async function getForecasts(limit = 20) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, round_number, btc_price_at_forecast, btc_price_at_review,
             actual_direction, actual_change_pct, consensus_direction,
             consensus_correct, individual_forecasts, created_at, reviewed_at
      FROM board_btc_forecasts 
      ORDER BY created_at DESC LIMIT $1
    `, [limit]);
    
    // Compute track record
    const reviewed = rows.filter(r => r.reviewed_at);
    const correct = reviewed.filter(r => r.consensus_correct).length;
    
    return {
      forecasts: rows,
      trackRecord: {
        total: reviewed.length,
        correct,
        accuracy: reviewed.length > 0 ? ((correct / reviewed.length) * 100).toFixed(1) : '0',
      },
      latest: rows[0] || null,
    };
  } finally {
    client.release();
  }
}


// ═══════════════════════════════════════════════════════════════
// GET /api/board/competition — Competition leaderboard
// ═══════════════════════════════════════════════════════════════

export async function getCompetition() {
  const client = await pool.connect();
  try {
    // Leaderboard
    const { rows: leaderboard } = await client.query(`
      SELECT member_id, 
             COUNT(*)::int as entries,
             COUNT(*) FILTER (WHERE evaluated_at IS NOT NULL)::int as evaluated,
             AVG(score) FILTER (WHERE score IS NOT NULL) as avg_score,
             MAX(score) as best_score,
             SUM(score) FILTER (WHERE score IS NOT NULL) as total_score
      FROM board_competitions WHERE active = true
      GROUP BY member_id ORDER BY AVG(score) DESC NULLS LAST
    `);
    
    // Recent entries
    const { rows: entries } = await client.query(`
      SELECT id, member_id, coin, regime_factor_1, regime_factor_2,
             hypothesis, entry_price, score, evaluated_at, created_at
      FROM board_competitions WHERE active = true
      ORDER BY created_at DESC LIMIT 20
    `);
    
    return { leaderboard, entries };
  } finally {
    client.release();
  }
}


// ═══════════════════════════════════════════════════════════════
// GET /api/board/meetings — Recent meeting summaries
// ═══════════════════════════════════════════════════════════════

export async function getRecentMeetings(limit = 10) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, round_number, chair_id, decision, motion_type, deployed,
             follow_up_target, follow_up_met, duration_ms, total_tokens,
             votes, digest, created_at
      FROM board_meetings WHERE phase = 'complete'
      ORDER BY created_at DESC LIMIT $1
    `, [limit]);
    
    return rows.map(m => ({
      ...m,
      votes: typeof m.votes === 'string' ? JSON.parse(m.votes) : m.votes,
    }));
  } finally {
    client.release();
  }
}


// ═══════════════════════════════════════════════════════════════
// STANDALONE SERVER (if run directly)
// ═══════════════════════════════════════════════════════════════

const isDirectRun = process.argv[1] && process.argv[1].includes('board-api');
if (isDirectRun) {
  const http = await import('http');
  const PORT = process.env.BOARD_API_PORT || 3002;
  
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    try {
      if (url.pathname === '/api/board/hero' && req.method === 'GET') {
        const data = await getHeroContent();
        res.writeHead(200);
        res.end(JSON.stringify(data));
      }
      else if (url.pathname === '/api/board/hero/history' && req.method === 'GET') {
        const data = await getHeroHistory();
        res.writeHead(200);
        res.end(JSON.stringify(data));
      }
      else if (url.pathname === '/api/board/feedback' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const result = await submitFeedback(data);
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }
      else if (url.pathname === '/api/board/forecast' && req.method === 'GET') {
        const data = await getForecasts();
        res.writeHead(200);
        res.end(JSON.stringify(data));
      }
      else if (url.pathname === '/api/board/competition' && req.method === 'GET') {
        const data = await getCompetition();
        res.writeHead(200);
        res.end(JSON.stringify(data));
      }
      else if (url.pathname === '/api/board/meetings' && req.method === 'GET') {
        const data = await getRecentMeetings();
        res.writeHead(200);
        res.end(JSON.stringify(data));
      }
      else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found', endpoints: [
          'GET /api/board/hero',
          'GET /api/board/hero/history',
          'POST /api/board/feedback',
          'GET /api/board/forecast',
          'GET /api/board/competition',
          'GET /api/board/meetings',
        ]}));
      }
    } catch (err) {
      console.error(`[board-api] Error:`, err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  
  server.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║  NTLGNC Board API v3 — port ${PORT}                    ║`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);
    console.log(`  GET  /api/board/hero         — Active hero content`);
    console.log(`  GET  /api/board/hero/history  — Hero history`);
    console.log(`  POST /api/board/feedback     — Submit vote`);
    console.log(`  GET  /api/board/forecast     — BTC forecasts`);
    console.log(`  GET  /api/board/competition  — Leaderboard`);
    console.log(`  GET  /api/board/meetings     — Recent meetings\n`);
  });
}

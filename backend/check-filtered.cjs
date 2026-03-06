require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

async function computeFilteredOutcomes() {
  const client = await pool.connect();
  console.log('\n═══ FILTERED SIGNAL OUTCOME ANALYSIS ═══\n');

  try {
    // Ensure table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS filtered_signal_outcomes (
        id SERIAL PRIMARY KEY,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        total_filtered INTEGER,
        total_evaluated INTEGER,
        hypothetical_avg_return FLOAT,
        hypothetical_win_rate FLOAT,
        hypothetical_cum_return FLOAT,
        actual_avg_return FLOAT,
        actual_win_rate FLOAT,
        actual_cum_return FLOAT,
        filter_value_pct FLOAT,
        direction_breakdown JSONB,
        per_filter_breakdown JSONB,
        sample_size_note TEXT
      )
    `);

    // Get all filtered signals with their strategy's barMinutes
    const { rows: filtered } = await client.query(`
      SELECT f.id, f.symbol, f.direction, f."entryPrice", f."createdAt", 
             f."holdBars", f."strategyId",
             COALESCE(s."barMinutes", 1) as "barMinutes"
      FROM "FracmapSignal" f
      LEFT JOIN "FracmapStrategy" s ON f."strategyId" = s.id
      WHERE f.status = 'filtered' AND f."entryPrice" > 0
      ORDER BY f."createdAt" DESC
    `);

    console.log(`Total filtered signals: ${filtered.length}`);

    // Get actual closed signal performance for comparison
    const { rows: [actualStats] } = await client.query(`
      SELECT 
        COUNT(*) as total,
        AVG("returnPct") as avg_return,
        SUM("returnPct") as cum_return,
        COUNT(*) FILTER (WHERE "returnPct" > 0) as wins
      FROM "FracmapSignal" WHERE status = 'closed' AND "returnPct" IS NOT NULL
    `);

    const actualTotal = parseInt(actualStats.total);
    const actualAvgReturn = parseFloat(actualStats.avg_return) || 0;
    const actualCumReturn = parseFloat(actualStats.cum_return) || 0;
    const actualWinRate = actualTotal > 0 ? parseInt(actualStats.wins) / actualTotal * 100 : 0;

    console.log(`\nActual traded signals: ${actualTotal}, avg return: ${actualAvgReturn.toFixed(4)}%, WR: ${actualWinRate.toFixed(1)}%, cum: ${actualCumReturn.toFixed(2)}%`);

    // For each filtered signal, look up what price was holdBars later
    let evaluated = 0;
    let hypotheticalReturns = [];
    let skipped = 0;

    for (const sig of filtered) {
      const barMs = sig.barMinutes * 60 * 1000;
      const entryTime = new Date(sig.createdAt).getTime();
      const exitTime = entryTime + (sig.holdBars * barMs);
      
      // Don't evaluate signals that haven't "expired" yet
      if (exitTime > Date.now()) {
        skipped++;
        continue;
      }

      // Determine candle table
      let table = 'Candle1m';
      if (sig.barMinutes >= 1440) table = 'Candle1d';
      else if (sig.barMinutes >= 60) table = 'Candle1h';

      // Get the candle at exit time
      try {
        const { rows } = await client.query(`
          SELECT close FROM "${table}" 
          WHERE symbol = $1 AND timestamp <= $2 
          ORDER BY timestamp DESC LIMIT 1
        `, [sig.symbol, new Date(exitTime).toISOString()]);

        if (rows.length > 0) {
          const exitPrice = parseFloat(rows[0].close);
          let ret;
          if (sig.direction === 'LONG') {
            ret = (exitPrice / sig.entryPrice - 1) * 100;
          } else {
            ret = (sig.entryPrice / exitPrice - 1) * 100;
          }
          
          // Sanity check - ignore extreme outliers (data errors)
          if (Math.abs(ret) < 50) {
            hypotheticalReturns.push({
              symbol: sig.symbol,
              direction: sig.direction,
              entryPrice: sig.entryPrice,
              exitPrice,
              returnPct: ret,
              holdBars: sig.holdBars,
              barMinutes: sig.barMinutes
            });
            evaluated++;
          }
        }
      } catch (e) {
        // Skip if candle lookup fails
      }

      // Progress logging
      if ((evaluated + skipped) % 100 === 0) {
        process.stdout.write(`\r  Processing: ${evaluated + skipped}/${filtered.length}...`);
      }
    }

    console.log(`\nEvaluated: ${evaluated}, Skipped (still open): ${skipped}`);

    if (evaluated === 0) {
      console.log('No filtered signals could be evaluated yet. Need more time for holdBars to expire.');
      client.release();
      pool.end();
      return;
    }

    // Compute hypothetical stats
    const hypReturns = hypotheticalReturns.map(r => r.returnPct);
    const hypCumReturn = hypReturns.reduce((s, r) => s + r, 0);
    const hypAvgReturn = hypCumReturn / evaluated;
    const hypWins = hypReturns.filter(r => r > 0).length;
    const hypWinRate = (hypWins / evaluated) * 100;

    // Filter value: how much better/worse would we be if we'd traded them?
    const filterValuePct = actualAvgReturn - hypAvgReturn;

    console.log(`\n═══ RESULTS ═══`);
    console.log(`Filtered signals evaluated: ${evaluated}`);
    console.log(`Hypothetical avg return:    ${hypAvgReturn.toFixed(4)}%`);
    console.log(`Hypothetical win rate:      ${hypWinRate.toFixed(1)}%`);
    console.log(`Hypothetical cum return:    ${hypCumReturn.toFixed(2)}%`);
    console.log(`\nActual avg return:          ${actualAvgReturn.toFixed(4)}%`);
    console.log(`Actual win rate:            ${actualWinRate.toFixed(1)}%`);
    console.log(`Actual cum return:          ${actualCumReturn.toFixed(2)}%`);
    console.log(`\nFilter value (actual - hyp): ${filterValuePct > 0 ? '+' : ''}${filterValuePct.toFixed(4)}% per trade`);
    
    if (filterValuePct > 0) {
      console.log(`\n✅ Filters are HELPING — blocked signals would have performed WORSE`);
    } else {
      console.log(`\n❌ Filters are HURTING — blocked signals would have performed BETTER`);
    }

    // Direction breakdown
    const longFiltered = hypotheticalReturns.filter(r => r.direction === 'LONG');
    const shortFiltered = hypotheticalReturns.filter(r => r.direction === 'SHORT');
    
    const dirBreakdown = {
      long: {
        count: longFiltered.length,
        avgReturn: longFiltered.length > 0 ? longFiltered.reduce((s, r) => s + r.returnPct, 0) / longFiltered.length : 0,
        winRate: longFiltered.length > 0 ? longFiltered.filter(r => r.returnPct > 0).length / longFiltered.length * 100 : 0,
        cumReturn: longFiltered.reduce((s, r) => s + r.returnPct, 0)
      },
      short: {
        count: shortFiltered.length,
        avgReturn: shortFiltered.length > 0 ? shortFiltered.reduce((s, r) => s + r.returnPct, 0) / shortFiltered.length : 0,
        winRate: shortFiltered.length > 0 ? shortFiltered.filter(r => r.returnPct > 0).length / shortFiltered.length * 100 : 0,
        cumReturn: shortFiltered.reduce((s, r) => s + r.returnPct, 0)
      }
    };

    console.log(`\nLONG filtered: ${dirBreakdown.long.count} signals, avg ${dirBreakdown.long.avgReturn.toFixed(4)}%, WR ${dirBreakdown.long.winRate.toFixed(1)}%`);
    console.log(`SHORT filtered: ${dirBreakdown.short.count} signals, avg ${dirBreakdown.short.avgReturn.toFixed(4)}%, WR ${dirBreakdown.short.winRate.toFixed(1)}%`);

    // Top 5 best and worst filtered signals
    const sorted = [...hypotheticalReturns].sort((a, b) => b.returnPct - a.returnPct);
    console.log(`\nTop 5 BEST filtered signals (missed profits):`);
    sorted.slice(0, 5).forEach(r => console.log(`  ${r.symbol} ${r.direction} ${r.returnPct > 0 ? '+' : ''}${r.returnPct.toFixed(3)}%`));
    console.log(`\nTop 5 WORST filtered signals (avoided losses):`);
    sorted.slice(-5).reverse().forEach(r => console.log(`  ${r.symbol} ${r.direction} ${r.returnPct > 0 ? '+' : ''}${r.returnPct.toFixed(3)}%`));

    // Per-filter breakdown — which filter blocked what, and how those signals performed
    const perFilterBreakdown = {};
    for (const sig of filtered) {
      // We need to look up which filter blocked it
    }
    // Query filtered signals with their filter_id
    const { rows: filteredWithFilter } = await client.query(`
      SELECT f.id, f.symbol, f.direction, f."entryPrice", f."createdAt",
             f."holdBars", f."strategyId", f.filtered_by,
             COALESCE(s."barMinutes", 1) as "barMinutes"
      FROM "FracmapSignal" f
      LEFT JOIN "FracmapStrategy" s ON f."strategyId" = s.id
      WHERE f.status = 'filtered' AND f."entryPrice" > 0 AND f.filtered_by IS NOT NULL
      ORDER BY f."createdAt" DESC
    `);
    
    // Group by filter_id and compute hypothetical returns for each
    const byFilter = {};
    for (const sig of filteredWithFilter) {
      if (!byFilter[sig.filtered_by]) byFilter[sig.filtered_by] = [];
      byFilter[sig.filtered_by].push(sig);
    }
    
    // Get filter names
    const { rows: filterInfo } = await client.query(
      `SELECT id, feature, conditions, timeframe, created_at FROM board_filters ORDER BY id`
    );
    const filterMap = {};
    for (const f of filterInfo) filterMap[f.id] = f;
    
    for (const [filterId, sigs] of Object.entries(byFilter)) {
      const fInfo = filterMap[filterId] || { feature: 'unknown', timeframe: 'all' };
      const evaluated = [];
      
      for (const sig of sigs) {
        const barMs = sig.barMinutes * 60 * 1000;
        const entryTime = new Date(sig.createdAt).getTime();
        const exitTime = entryTime + (sig.holdBars * barMs);
        if (exitTime > Date.now()) continue;
        
        let table = 'Candle1m';
        if (sig.barMinutes >= 1440) table = 'Candle1d';
        else if (sig.barMinutes >= 60) table = 'Candle1h';
        
        try {
          const { rows } = await client.query(`
            SELECT close FROM "${table}"
            WHERE symbol = $1 AND timestamp <= $2
            ORDER BY timestamp DESC LIMIT 1
          `, [sig.symbol, new Date(exitTime).toISOString()]);
          
          if (rows.length > 0) {
            const exitPrice = parseFloat(rows[0].close);
            const ret = sig.direction === 'LONG'
              ? (exitPrice / sig.entryPrice - 1) * 100
              : (sig.entryPrice / exitPrice - 1) * 100;
            if (Math.abs(ret) < 50) {
              evaluated.push({ direction: sig.direction, returnPct: ret });
            }
          }
        } catch {}
      }
      
      if (evaluated.length > 0) {
        const rets = evaluated.map(e => e.returnPct);
        const longRets = evaluated.filter(e => e.direction === 'LONG').map(e => e.returnPct);
        const shortRets = evaluated.filter(e => e.direction === 'SHORT').map(e => e.returnPct);
        const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        const wr = arr => arr.length > 0 ? arr.filter(r => r > 0).length / arr.length * 100 : 0;
        
        perFilterBreakdown[filterId] = {
          filter_id: parseInt(filterId),
          feature: fInfo.feature,
          timeframe: fInfo.timeframe || 'all',
          deployed_at: fInfo.created_at,
          total_blocked: sigs.length,
          evaluated: evaluated.length,
          avg_return: avg(rets),
          win_rate: wr(rets),
          cum_return: rets.reduce((a, b) => a + b, 0),
          long: { count: longRets.length, avg_return: avg(longRets), win_rate: wr(longRets) },
          short: { count: shortRets.length, avg_return: avg(shortRets), win_rate: wr(shortRets) },
          verdict: avg(rets) < actualAvgReturn ? 'POSITIVE' : avg(rets) > actualAvgReturn ? 'NEGATIVE' : 'NEUTRAL',
          hours_active: Math.round((Date.now() - new Date(fInfo.created_at).getTime()) / 3600000),
          statistically_valid: evaluated.length >= 200,
        };
        
        const pf = perFilterBreakdown[filterId];
        console.log(`  Filter #${filterId} (${pf.feature} [${pf.timeframe}]): ${pf.evaluated} evaluated, avg ${pf.avg_return.toFixed(4)}%, verdict: ${pf.verdict}${pf.statistically_valid ? '' : ' ⚠ LOW SAMPLE'}`);
      }
    }

    // Store results
    await client.query(`
      INSERT INTO filtered_signal_outcomes 
        (total_filtered, total_evaluated, hypothetical_avg_return, hypothetical_win_rate,
         hypothetical_cum_return, actual_avg_return, actual_win_rate, actual_cum_return,
         filter_value_pct, direction_breakdown, per_filter_breakdown, sample_size_note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      filtered.length, evaluated, hypAvgReturn, hypWinRate, hypCumReturn,
      actualAvgReturn, actualWinRate, actualCumReturn, filterValuePct,
      JSON.stringify(dirBreakdown), JSON.stringify(perFilterBreakdown),
      `${evaluated} of ${filtered.length} evaluated (${skipped} still within holdBars window)`
    ]);

    console.log(`\n📊 Results saved to filtered_signal_outcomes table`);

  } finally {
    client.release();
    pool.end();
  }
}

computeFilteredOutcomes().catch(e => { console.error(e); pool.end(); });

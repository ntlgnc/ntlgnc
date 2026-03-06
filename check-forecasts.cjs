const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Count total forecasts
  const { rows: [counts] } = await c.query(`
    SELECT COUNT(*) as total,
           COUNT(reviewed_at) as reviewed,
           COUNT(consensus_correct) FILTER (WHERE consensus_correct = true) as correct,
           MIN(created_at) as first_forecast,
           MAX(created_at) as last_forecast
    FROM board_btc_forecasts
  `);
  console.log('Forecast counts:', counts);

  // Sample a scored forecast to understand data structure
  const { rows: [sample] } = await c.query(`
    SELECT id, round_number, btc_price_at_forecast, btc_price_at_review,
           actual_direction, actual_change_pct, consensus_direction, consensus_correct,
           individual_forecasts, individual_scores,
           group_vote_direction, group_vote_details,
           created_at, reviewed_at
    FROM board_btc_forecasts
    WHERE reviewed_at IS NOT NULL
    ORDER BY created_at ASC LIMIT 1
  `);
  console.log('\nEarliest scored forecast:');
  console.log('  id:', sample.id, 'round:', sample.round_number);
  console.log('  created_at:', sample.created_at);
  console.log('  btc_price_at_forecast:', sample.btc_price_at_forecast);
  console.log('  btc_price_at_review:', sample.btc_price_at_review);
  console.log('  actual_direction:', sample.actual_direction);
  console.log('  actual_change_pct:', sample.actual_change_pct);
  console.log('  consensus_direction:', sample.consensus_direction);
  console.log('  consensus_correct:', sample.consensus_correct);

  const indivForecasts = typeof sample.individual_forecasts === 'string' ? JSON.parse(sample.individual_forecasts) : sample.individual_forecasts;
  const indivScores = typeof sample.individual_scores === 'string' ? JSON.parse(sample.individual_scores) : sample.individual_scores;
  console.log('\n  individual_forecasts keys:', Object.keys(indivForecasts || {}));
  if (indivForecasts) {
    for (const [k, v] of Object.entries(indivForecasts)) {
      console.log(`    ${k}:`, JSON.stringify(v).slice(0, 200));
    }
  }
  console.log('\n  individual_scores keys:', Object.keys(indivScores || {}));
  if (indivScores) {
    for (const [k, v] of Object.entries(indivScores)) {
      console.log(`    ${k}:`, JSON.stringify(v).slice(0, 200));
    }
  }

  // Check group_vote_details structure
  const gvd = typeof sample.group_vote_details === 'string' ? JSON.parse(sample.group_vote_details) : sample.group_vote_details;
  if (gvd) {
    console.log('\n  group_vote_details sample:');
    for (const [k, v] of Object.entries(gvd)) {
      console.log(`    ${k}:`, JSON.stringify(v).slice(0, 200));
    }
  }

  // Check if we have BTC 1m bars available for the forecast period
  const { rows: [barRange] } = await c.query(`
    SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest, COUNT(*) as total
    FROM "Candle1m"
    WHERE symbol = 'BTCUSDT'
  `);
  console.log('\nBTC 1m bar range:', barRange);

  await c.end();
})();

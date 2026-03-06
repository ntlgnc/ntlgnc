/**
 * One-off: Save signal detection alignment doc to research_documents table
 */
require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const title = 'Signal Detection Logic — Corrected Alignment (Mar 2026)';
  const desc = 'Documents the 7 differences between the scanner and live engine, the corrections made, and the final aligned version.';
  const content = `# Signal Detection Logic — Corrected Alignment

## Date: 4 March 2026

## Summary
The live signal engine (live-signals.cjs), backprop engine (backprop-signals.cjs), and scanner (robustness-cron.js) were found to have 7 critical differences in signal detection. All three files have been aligned to the corrected logic described below.

## Corrected Signal Detection Rules

### 1. Touch Condition: Pierce-and-Close (Reversal Confirmation)
- **LONG**: bar.low < lower_band AND bar.close > lower_band
- **SHORT**: bar.high > upper_band AND bar.close < upper_band
- Rationale: Price must demonstrate penetration AND reversal. A simple touch (<=) is insufficient — the close back above/below confirms rejection.
- Note: The scanner previously used simple touch (<=) which was a simplification, not the original design.

### 2. Near-Miss: Temporal (X-axis)
- Check the pierce-and-close pattern on the PREVIOUS bar (i-1)
- No look-ahead bias because indicator bands are computed from lagged data
- Future consideration: Add Y-axis proximity near-miss (within X% of bandwidth) for IS/OOS optimization. The % should be scaled by band width (upper-lower) to be scale-invariant, not a fixed 0.2%.

### 3. Spike/Cusp Filter: Always Applied
- **LONG**: isLocalMax on lower band (spike UP = cusp pointing toward price)
- **SHORT**: isLocalMin on upper band (spike DOWN = cusp pointing toward price)
- Window: Math.max(2, cycle/6)
- Can look forward in this window because bands are lagged
- BUG FOUND: The scanner had these REVERSED (isLocalMin for longs, isLocalMax for shorts). This has been corrected in all three files.
- Always applied as part of the touch condition, not optional

### 4. PriceExtreme: Per-Band
- Checked per-band with window = cycle/6 (same as spike window)
- Each band's vote is independently filtered
- More principled than checking once at the end with maxCycle/2

### 5. Combined Spike Filter
- When spikeFilter=true (1m, 1h strategies): reject bars where BOTH longVotes > 0 AND shortVotes > 0
- Mixed signals indicate ambiguity — skip the bar entirely
- For 1D (spikeFilter=false): mixed signals allowed, direction decided by majority

### 6. Strength: Direction-Specific
- longVotes checked against minStr for LONG signals
- shortVotes checked against minStr for SHORT signals
- NOT combined (totalVotes = long + short is a fudge)
- For LONG: also requires longVotes >= shortVotes

### 7. Hold Bars: Floor of 3
- holdBars = Math.max(3, Math.round(maxCycle / holdDiv))
- Prevents trivially short hold periods

## Strategy Parameters (from DB)
| TF | Cycles | minStr | minCyc | spike | nearMiss | holdDiv | priceExt |
|----|--------|--------|--------|-------|----------|---------|----------|
| 1m | C10-C100 | 1 | 55 | true | true | 4 | true |
| 1h | C55-C89 | 1 | 64 | true | true | 5 | true |
| 1d | C2-C12 | 1 | 0 | false | false | 2 | true |

## Backprop Results (Corrected Logic, 50 days)
| TF | Signals | Hedged Pairs | Date Range |
|----|---------|-------------|------------|
| 1m | 8,873 | 2,312 | Feb 9 - Mar 4 |
| 1h | 2,077 | 525 | Nov 29 - Mar 4 |
| 1d | 671 | 211 | Dec 5 - Mar 3 |

2,695 closed hedged pairs: 60% win rate, +0.763% avg return

## Files Modified
- backend/live-signals.cjs — detectSignalAtBar function
- backend/backprop-signals.cjs — detectSignalAtBar function
- backend/robustness-cron.js — detectEnsembleSignals function (scanner bug fixed)

## Future Work
- Add Y-axis proximity near-miss (bandwidth-scaled) to scanner for IS/OOS optimization
- Both X-axis and Y-axis near-miss should be available as toggleable parameters
`;

  await c.query(
    'INSERT INTO research_documents (title, description, doc_type, content, tags, author) VALUES ($1, $2, $3, $4, $5, $6)',
    [title, desc, 'note', content, ['signal-detection', 'alignment', 'scanner', 'backprop'], 'Claude']
  );
  console.log('Research doc saved successfully');
  await c.end();
})();

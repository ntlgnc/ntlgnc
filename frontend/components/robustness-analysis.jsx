import { useState } from "react";

const C = { bg:"#0a0e17", card:"#111827", border:"#1e293b", gold:"#d4a843", cyan:"#06b6d4",
  green:"#22c55e", red:"#ef4444", yellow:"#facc15", purple:"#a78bfa", dim:"#64748b", text:"#e2e8f0", muted:"#94a3b8" };
const Box = ({children, style={}}) => <div style={{background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:16, ...style}}>{children}</div>;
const H = ({children, color=C.gold}) => <div style={{fontSize:13,fontWeight:800,color,marginBottom:10,letterSpacing:0.3}}>{children}</div>;
const P = ({children}) => <p style={{fontSize:11,lineHeight:1.85,color:"#cbd5e1",margin:"6px 0"}}>{children}</p>;
const Em = ({children,c=C.yellow}) => <strong style={{color:c}}>{children}</strong>;
const Warn = ({children}) => <div style={{background:"#ef444410",border:`1px solid ${C.red}25`,borderRadius:6,padding:"10px 14px",margin:"8px 0",fontSize:10,lineHeight:1.7,color:"#fca5a5"}}>{children}</div>;
const Good = ({children}) => <div style={{background:"#22c55e10",border:`1px solid ${C.green}25`,borderRadius:6,padding:"10px 14px",margin:"8px 0",fontSize:10,lineHeight:1.7,color:"#86efac"}}>{children}</div>;

export default function App() {
  const [section, setSection] = useState("method");
  const secs = [
    {k:"method",l:"1. Methodology Audit"},
    {k:"oos",l:"2. OOS Robustness"},
    {k:"regime",l:"3. Regime Stability"},
    {k:"gaps",l:"4. Statistical Gaps"},
    {k:"features",l:"5. Additional Features"},
    {k:"integration",l:"6. Scanner + LLM Integration"},
  ];

  return (
    <div style={{background:C.bg,color:C.text,minHeight:"100vh",fontFamily:"'SF Mono','Fira Code',monospace",padding:"20px 24px",maxWidth:900,margin:"0 auto"}}>
      <div style={{borderBottom:`2px solid ${C.gold}40`,paddingBottom:14,marginBottom:20}}>
        <h1 style={{fontSize:18,fontWeight:800,color:C.gold,margin:0}}>FRACMAP SCANNER — SCIENTIFIC ROBUSTNESS ANALYSIS</h1>
        <p style={{fontSize:10,color:C.muted,margin:"4px 0 0"}}>Statistical audit of methodology, OOS validation, regime analysis stability, and enhancement opportunities</p>
      </div>

      <div style={{display:"flex",gap:2,marginBottom:20,background:C.card,borderRadius:8,padding:3,flexWrap:"wrap"}}>
        {secs.map(s=>(
          <button key={s.k} onClick={()=>setSection(s.k)} style={{
            padding:"6px 12px",borderRadius:6,fontSize:10,fontWeight:700,fontFamily:"inherit",
            background:section===s.k?`${C.gold}18`:"transparent",color:section===s.k?C.gold:C.dim,
            border:section===s.k?`1px solid ${C.gold}40`:"1px solid transparent",cursor:"pointer"
          }}>{s.l}</button>
        ))}
      </div>

      {/* ═══ 1. METHODOLOGY AUDIT ═══ */}
      {section === "method" && (<div>
        <Box style={{marginBottom:16}}>
          <H>1.1 — Is The Backtest Methodology Sound?</H>
          <P>The core methodology is a walk-forward optimisation with temporal split: first N% of data for in-sample optimisation, remaining (100-N)% for out-of-sample validation. This is the correct basic framework for avoiding look-ahead bias. Let's audit each component:</P>

          <Good><Em c={C.green}>✅ Temporal split is correct.</Em> The data is split chronologically — the OOS window always comes AFTER the IS window. There's no random shuffling that would leak future information into the training set. The split index is computed as <code>Math.round(coinBars.length * splitPct / 100)</code> which is deterministic and clean.</Good>

          <Good><Em c={C.green}>✅ OOS data is genuinely blind.</Em> The winning strategy is selected using IS data only, then applied unchanged to OOS data. The OOS computation uses fresh band calculations from OOS bars — it doesn't inherit any state from IS. The signals are detected independently.</Good>

          <Good><Em c={C.green}>✅ Random walk validation is conclusive.</Em> The random walk test produces IS Sharpe 60.5 but OOS Sharpe -0.09. This is exactly what you'd expect — the optimiser overfits noise in IS, but the OOS gate correctly catches it. If there were look-ahead bias, random walks would show positive OOS Sharpe too.</Good>

          <Warn><Em c={C.red}>⚠️ Single split point is fragile.</Em> Using one 50/50 split gives you exactly ONE draw of the OOS window. If the OOS window happens to coincide with a favourable regime (trending market, high volatility), results look better than reality. A more robust approach would be rolling walk-forward: slide the IS/OOS window forward in time and average across multiple OOS windows. With only ~15 days of data, you can do perhaps 5-6 rolling splits at 50/50.</Warn>

          <Warn><Em c={C.red}>⚠️ Multiple hypothesis testing problem.</Em> You're testing 320 strategy combinations across 20 coins. The "winner" is selected from 320 options. Even under the null hypothesis (no real edge), the best of 320 random strategies will show a positive IS Sharpe by chance. The OOS validation partially addresses this, but the selection process still inflates expectations. A Bonferroni correction would require p &lt; 0.05/320 ≈ 0.00016 for the WINNER to be individually significant. The t-test gives p&lt;0.001 for ZEC and p=0.025 for HBAR — ZEC passes Bonferroni, HBAR does not.</Warn>

          <Warn><Em c={C.red}>⚠️ Survivorship in the coin universe.</Em> The 20 coins selected are all currently large-cap survivors. Coins that crashed to zero during the test window aren't included. This isn't a fatal flaw (you'd only trade live coins anyway), but it means the backtest overstates the strategy's historical edge because it excludes periods where these coins may have exhibited different behaviour.</Warn>
        </Box>

        <Box style={{marginBottom:16}}>
          <H>1.2 — Sharpe Ratio Computation</H>
          <P>The Sharpe computation is well-implemented. It builds a per-bar return series (0 when flat), aggregates to daily returns, then annualises with √365. This is the correct time-series approach — it doesn't inflate Sharpe by ignoring idle time. Key properties:</P>

          <Good><Em c={C.green}>✅ Flat-bar returns are zero, not ignored.</Em> Days with no trades contribute 0% return, which correctly penalises strategies that trade infrequently. This prevents the "100% win rate on 3 trades" inflation.</Good>

          <Good><Em c={C.green}>✅ Daily aggregation avoids autocorrelation.</Em> Minute-bar returns would show strong serial correlation from position overlaps. Aggregating to daily first is standard practice.</Good>

          <P>However, an OOS Sharpe of 3.96 annualised from ~7 days of data deserves scrutiny. With only ~7 daily return observations, the standard error of the Sharpe estimate itself is approximately √(2/n) ≈ √(2/7) ≈ 0.53. So the 95% confidence interval for the true Sharpe is roughly 3.96 ± 1.04, i.e. [2.92, 5.00]. The edge is likely real but the point estimate is noisy.</P>
        </Box>

        <Box>
          <H>1.3 — Bootstrap Test Design</H>
          <P>The bootstrap is well-designed. It preserves the actual long/short ratio from the strategy and randomises entry timing only. This tests the null hypothesis: "does entry timing matter, given the same directional mix?" This is the right question to ask.</P>

          <Good><Em c={C.green}>✅ Direction-aware null hypothesis.</Em> Random entries use the SAME long/short sequence as the real strategy. This means the bootstrap can't be fooled by a rising market making all longs profitable — the random longs would also benefit.</Good>

          <P>The result: 4/20 coins show bootstrap p &lt; 0.05. Given 20 tests at α=0.05, you'd expect 1 false positive by chance. So roughly 3 of the 4 significant coins likely have genuine timing alpha. This is a modest but real finding.</P>
        </Box>
      </div>)}

      {/* ═══ 2. OOS ROBUSTNESS ═══ */}
      {section === "oos" && (<div>
        <Box style={{marginBottom:16}}>
          <H>2.1 — What Does 51% IS→OOS Retention Mean?</H>
          <P>The winner strategy has IS Sharpe 7.83 and OOS Sharpe 3.96, giving 51% retention. This number needs context:</P>

          <P><Em>For a 320-combo search, 51% retention is acceptable.</Em> With more degrees of freedom in the optimiser, you expect more IS inflation and thus lower retention. A random walk shows ~0% retention (OOS ≈ 0). Real but weak edges show 20-40% retention. Your 51% suggests a genuine underlying pattern with moderate overfitting. The fact that the top 6 strategies all produce identical results (×1, ×2, ×3 at same settings) is actually reassuring — the strength threshold doesn't matter much, meaning the signal isn't brittle.</P>

          <Warn><Em c={C.red}>⚠️ IS→OOS retention varies wildly per coin.</Em> ZEC goes from IS -3.9 to OOS +16.2 (negative retention but positive improvement). SOL goes from IS 36.0 to OOS 11.9 (33% retention). XLM goes from IS 12.4 to OOS -12.3 (complete inversion). This variance suggests that the "universal" strategy is not truly universal — it's being carried by a subset of coins while others show no stable relationship between IS and OOS performance.</Warn>
        </Box>

        <Box style={{marginBottom:16}}>
          <H>2.2 — Is 13/20 Positive Coins Meaningful?</H>
          <P>Under the null hypothesis (no edge), you'd expect ~10/20 coins to be positive by chance. Observing 13/20 is a binomial test: p = P(X ≥ 13 | n=20, p=0.5) ≈ 0.132. <Em c={C.red}>This is NOT statistically significant at the 5% level.</Em></P>

          <P>However, this understates the evidence because the MAGNITUDE of the positive coins is much larger than the negative ones. The top 6 coins average SR +12.6 while the bottom 6 average SR -7.0. A sign-rank test on the Sharpe values (which accounts for magnitude) gives a more favourable result. The key question isn't "how many coins are positive" but "does the portfolio-level alpha survive?"</P>

          <Good><Em c={C.green}>The portfolio-level metrics are more convincing:</Em> Average OOS return +2.58%, average PF 1.26, average win rate 53.3%. These are modest but consistent with a real edge. The profit factor of 1.26 means the strategy earns £1.26 for every £1.00 lost — not spectacular, but sufficient for a high-frequency approach with many trades.</Good>
        </Box>

        <Box>
          <H>2.3 — The Short-Side Dominance: Real or Artefact?</H>
          <P>Shorts show SR 14.8 vs longs SR 0.8. Before concluding this is an inherent property of the Fracmap, consider:</P>

          <P><Em>Was the OOS window a net-declining period?</Em> If crypto prices fell during the OOS period, ALL shorts would be biased positive regardless of timing quality. The bootstrap partially controls for this (random shorts would also benefit), but the 3 coins with bootstrap-significant shorts (ZEC p=0.022, SOL p=0.026, LINK p=0.049) do provide some evidence that the short timing is genuinely good.</P>

          <P><Em>Counter-evidence:</Em> ETH longs have SR -2.7 but ETH shorts have SR +16.5, and the bootstrap for ETH shorts is p=0.078 (marginal). This pattern — where longs are weak but shorts are strong on the SAME coin — is harder to explain purely by market direction. It suggests the Fracmap genuinely detects upper-band exhaustion better than lower-band exhaustion.</P>

          <Warn><Em c={C.red}>Verdict: Likely real but amplified by OOS market conditions.</Em> The asymmetry probably reflects both (a) a genuine property of cycle tops being sharper than bottoms AND (b) a favourable OOS window for shorts. Need more OOS windows (different time periods) to separate the two effects.</Warn>
        </Box>
      </div>)}

      {/* ═══ 3. REGIME STABILITY ═══ */}
      {section === "regime" && (<div>
        <Box style={{marginBottom:16}}>
          <H>3.1 — Is The Spearman ρ Test Adequate?</H>
          <P>The regime analysis computes Spearman rank correlation between IS bucket Sharpes and OOS bucket Sharpes. With only 3 buckets per feature, the Spearman ρ can only take values in {'{'}-1, -0.5, 0, 0.5, 1{'}'}. This is an extremely coarse measure. Here's why this matters:</P>

          <Warn><Em c={C.red}>⚠️ With 3 buckets, ρ=0.5 is the MINIMUM positive correlation.</Em> It means 2 out of 3 bucket rankings are preserved. ρ=1.0 means all 3 match. There is no granularity between these values. You cannot distinguish a "barely stable" feature (ρ=0.51 in continuous terms) from a "fairly stable" one (ρ=0.85) — both round to ρ=0.5 or 1.0.</Warn>

          <Warn><Em c={C.red}>⚠️ No significance test on ρ itself.</Em> With n=3, the critical value for Spearman ρ at p=0.05 (one-tailed) is ρ=1.0. That means only perfect rank preservation (ρ=1.0) is statistically significant at the 5% level with 3 buckets. <Em>Every feature with ρ=0.5 is technically NOT significantly stable.</Em> Only Vol State (ρ=1.0), Direction (ρ=1.0), and Max Trigger Cycle (ρ=1.0) pass this test.</Warn>

          <P><Em c={C.cyan}>Recommendation: Increase to 5 buckets.</Em> With 5 buckets, Spearman ρ has 120 possible values and the critical value drops to ~0.9 (exact) or ~0.78 (approximate). This would make the stability test far more informative. The trade-off is fewer signals per bucket — with 2,188 OOS signals and 5 buckets, you get ~440 per bucket on average, which is still plenty for reliable Sharpe estimates.</P>
        </Box>

        <Box style={{marginBottom:16}}>
          <H>3.2 — Which Regime Features Are Actually Robust?</H>

          <P><Em c={C.green}>Tier A — Statistically significant stability (ρ = 1.0):</Em></P>
          <div style={{background:C.bg,border:`1px solid ${C.green}25`,borderRadius:6,padding:14,margin:"8px 0",fontSize:10,lineHeight:1.8,color:C.muted}}>
            <div><Em c={C.green}>Vol State</Em> (spread 20.9, ρ=1.0): COMPRESSED is catastrophic (SR -10.0). NORMAL is profitable (SR 10.8). EXPANDING is slightly negative (SR -2.9). The ordering is perfectly preserved IS→OOS. With 207 COMPRESSED signals, the SR estimate has SE ≈ 20.9/√207 ≈ 1.45, so the negative sign is robust. <Em c={C.green}>This is your most reliable filter.</Em></div>
            <div style={{marginTop:8}}><Em c={C.green}>Direction</Em> (spread 14.0, ρ=1.0): Shorts consistently outperform longs. Both IS and OOS agree. As discussed, this may partially reflect the OOS market direction, but the bootstrap evidence supports real timing alpha on the short side.</div>
            <div style={{marginTop:8}}><Em c={C.green}>Max Trigger Cycle</Em> (spread 3.9, ρ=1.0): Longer cycles (>90) perform better. The spread is modest (3.9) so the absolute impact is small, but the relationship is perfectly stable. This makes theoretical sense — longer cycles represent slower, more persistent structural features.</div>
          </div>

          <P><Em c={C.yellow}>Tier B — Plausible but not proven (ρ = 0.5):</Em></P>
          <div style={{background:C.bg,border:`1px solid ${C.yellow}25`,borderRadius:6,padding:14,margin:"8px 0",fontSize:10,lineHeight:1.8,color:C.muted}}>
            <div><Em c={C.yellow}>Hour of Day</Em> (spread 23.7, ρ=0.5): Europe is worst, US is best, Asia is middle — but ρ=0.5 with 3 buckets is NOT statistically significant. The spread is large (23.7) which is encouraging, but one bucket ranking flipped. We don't know WHICH ranking flipped (was Europe best in IS and worst in OOS? Or was Asia/US the swap?). <Em c={C.yellow}>Need the actual IS bucket values to fully evaluate.</Em></div>
            <div style={{marginTop:8}}><Em c={C.yellow}>60-bar Trend</Em> (spread 18.6, ρ=0.5): "Up" trend is best (SR 19.5), "Down" is worst (SR 0.9). But with ρ=0.5, one ranking pair swapped. This could be meaningful or noise.</div>
            <div style={{marginTop:8}}><Em c={C.yellow}>1h/1d Vol Ratio</Em> (spread 20.3, ρ=0.5): Normal vol ratio is best (SR 12.3), extremes are negative. Same caveat — ρ=0.5 is the minimum positive rank correlation.</div>
          </div>

          <P><Em c={C.red}>Tier C — Inverted or insufficient (ρ ≤ 0 or n/a):</Em></P>
          <div style={{background:C.bg,border:`1px solid ${C.red}25`,borderRadius:6,padding:14,margin:"8px 0",fontSize:10,lineHeight:1.8,color:C.muted}}>
            <div><Em c={C.red}>Hurst Exponent</Em> (ρ=-0.5): Rankings inverted. BUT only 65 signals in the "Trending" bucket — this is way too few for a reliable Sharpe estimate. The inversion might be noise from small sample, not a real effect. <Em c={C.yellow}>Don't use it, but don't discard it either — re-evaluate with more data.</Em></div>
            <div style={{marginTop:8}}><Em c={C.red}>ATR Compression</Em> (ρ=-0.5): Also inverted. This is interesting because "Vol State" (ρ=1.0) measures a similar concept (ATR compression). The difference is that Vol State uses hard thresholds (0.6, 1.4) while ATR Compression uses different thresholds (0.7, 1.3). This suggests the exact threshold placement matters — the feature might be valid but the bucket boundaries need recalibration.</div>
            <div style={{marginTop:8}}><Em c={C.red}>5-day Trend, Vol Cluster, Regime</Em> (ρ=n/a): These have extreme bucket imbalances (2,125 vs 61 vs 2 for 5-day Trend). The "n/a" flags correctly that no meaningful stability test is possible. These features need rebalanced bucketing.</div>
          </div>
        </Box>

        <Box>
          <H>3.3 — Overall Regime Verdict</H>
          <P>The regime framework is conceptually sound — tagging signals with market context features and measuring differential performance is exactly the right approach. But the statistical execution has gaps:</P>
          <P>1. <Em>3 buckets is too coarse</Em> for Spearman ρ to be meaningful. Move to 5 buckets.</P>
          <P>2. <Em>No confidence intervals on bucket Sharpes.</Em> A bucket with n=65 and SR 13.8 has a standard error of roughly 13.8/√2 × √(2/65) ≈ 2.4. The 95% CI is [9.0, 18.6]. Without CIs, you can't tell if bucket differences are real or sampling noise.</P>
          <P>3. <Em>No permutation test on the spread itself.</Em> Spread = 20.9 for Vol State sounds large, but how often would you see spread ≥ 20 if you randomly assigned signals to buckets? A permutation test (shuffle bucket labels 10,000 times, compute spread each time) would give you a p-value for the spread. This is the missing statistical test.</P>
          <P>4. <Em>Feature interactions are not tested.</Em> Vol State × Hour of Day might have a much higher spread than either alone — or they might be redundant. A 2D contingency analysis (3×3 grid) would reveal interactions, at the cost of needing ~250 signals per cell.</P>
        </Box>
      </div>)}

      {/* ═══ 4. STATISTICAL GAPS ═══ */}
      {section === "gaps" && (<div>
        <Box style={{marginBottom:16}}>
          <H>4.1 — Missing Tests That Would Strengthen Confidence</H>

          <div style={{display:"grid",gap:12}}>
            {[
              {title:"Permutation test on regime spread",desc:"Shuffle signals across buckets 10,000 times. Compute spread each time. If the real spread exceeds 95% of permuted spreads, the feature is genuinely discriminative. This is the gold-standard non-parametric test.",priority:"CRITICAL",color:C.green},
              {title:"Rolling walk-forward validation",desc:"Instead of one 50/50 split, do 5+ overlapping splits (e.g., 0-50/50-100, 10-60/60-100, 20-70/70-100, etc.) and average OOS Sharpes. This gives a distribution of OOS performance, not a single point estimate.",priority:"HIGH",color:C.green},
              {title:"Confidence intervals on bucket Sharpes",desc:"Each bucket Sharpe should show ± standard error. SE ≈ SR × √(2/n) for the standard approximation. This makes the table immediately interpretable — if error bars overlap between buckets, the spread is noise.",priority:"HIGH",color:C.yellow},
              {title:"Multiple testing correction for features",desc:"You're testing 16 features. At α=0.05, you'd expect ~1 false positive. Apply Benjamini-Hochberg FDR correction to the spread p-values (from the permutation test above).",priority:"MEDIUM",color:C.yellow},
              {title:"Feature interaction matrix",desc:"Test all pairwise feature combinations (16×15/2 = 120 pairs). For each pair, compute the 2D contingency Sharpe grid and test whether the interaction spread exceeds the sum of marginal spreads.",priority:"MEDIUM",color:C.cyan},
              {title:"Temporal stability — split OOS into halves",desc:"Split the OOS data into OOS-1 and OOS-2. Recompute regime features on each half. If bucket rankings are stable across OOS-1 and OOS-2, confidence increases substantially.",priority:"HIGH",color:C.green},
            ].map((item,i) => (
              <div key={i} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:14}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                  <span style={{fontSize:10,fontWeight:800,color:item.color}}>{item.priority}</span>
                  <span style={{fontSize:11,fontWeight:700,color:C.text}}>{item.title}</span>
                </div>
                <div style={{fontSize:10,color:C.muted,lineHeight:1.7}}>{item.desc}</div>
              </div>
            ))}
          </div>
        </Box>

        <Box>
          <H>4.2 — Sample Size Adequacy</H>
          <P>With 2,188 OOS signals across 16 features with 3 buckets each, the average bucket has ~730 signals. This is generally adequate for Sharpe estimation (SE ≈ SR/√(n/2) ≈ 0.5 for a typical bucket). However:</P>
          <P>• <Em c={C.red}>Extreme buckets are underpopulated.</Em> "Trending" Hurst has only 65 signals. "TREND" regime has 1. "Bull" 5-day trend has 2. These buckets can't produce reliable estimates at all.</P>
          <P>• <Em>Per-coin sample sizes are small.</Em> With ~110 trades per coin, individual coin Sharpe estimates have SE ≈ 2-3. This is why only 2-4 coins achieve statistical significance individually — you simply don't have enough data per coin yet.</P>
          <P>• <Em c={C.green}>The aggregate is more reliable.</Em> 2,188 signals pooled across coins give much tighter estimates. The regime analysis operates at this pooled level, which is appropriate. But this assumes the features behave similarly across coins — which should be tested with per-coin regime heatmaps.</P>
        </Box>
      </div>)}

      {/* ═══ 5. ADDITIONAL FEATURES ═══ */}
      {section === "features" && (<div>
        <Box style={{marginBottom:16}}>
          <H>5.1 — Net Position As Regime Indicator</H>
          <P>You proposed using the rolling net position (how many coins are long vs short at any time) as a regime feature. This is a structurally excellent idea because:</P>

          <Good><Em c={C.green}>It's orthogonal to all existing features.</Em> Current features are all computed per-coin at the signal bar. Net position is a cross-sectional aggregate — it captures information that no single-coin feature can. Specifically, it measures "are cycle extremes occurring synchronously across coins?" If many coins hit upper bands simultaneously, that's a market-wide regime signal.</Good>

          <P><Em>Implementation for the regime table:</Em></P>
          <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:14,margin:"8px 0",fontSize:10,lineHeight:1.8,color:C.muted}}>
            <div>1. During OOS backtest, track all active positions across all 20 coins at each bar</div>
            <div>2. At each signal entry bar, compute: <code>netPos = activeLongs - activeShorts</code></div>
            <div>3. Bucket into 3 (or 5) groups: Strong Short Bias / Balanced / Strong Long Bias</div>
            <div>4. Measure bucket Sharpes, compute spread and IS→OOS ρ just like other features</div>
            <div>5. The feature must pass the same stability tests — if ρ &lt; 0.5, it gets flagged as unreliable</div>
          </div>

          <P><Em c={C.yellow}>Hypothesis:</Em> Given that shorts dominate, periods where the model is heavily net-short (many coins hitting upper bands) might be the highest-alpha regime. Conversely, periods of heavy net-long exposure might predict lower performance. This is testable.</P>
        </Box>

        <Box style={{marginBottom:16}}>
          <H>5.2 — Other Cross-Sectional Features Worth Testing</H>
          <div style={{display:"grid",gap:10}}>
            {[
              {name:"Signal Density",desc:"Number of signals triggered across all coins in the last 60 bars. High density = strong cycle convergence. Low density = isolated signals. Test whether cluster signals perform differently from isolated ones."},
              {name:"Cross-Coin Correlation",desc:"Rolling 60-bar correlation between the current coin and BTC. In high-correlation regimes, signals may be redundant (all coins moving together). In low-correlation regimes, signals may carry more independent information."},
              {name:"Directional Consensus",desc:"Of all signals generated in the last 60 bars across all coins, what fraction are LONGs vs SHORTs? If 80% are longs, the model is seeing broad cycle lows. Different from net position (which measures ACTIVE positions, not just signal generation)."},
              {name:"Win Streak / Drawdown State",desc:"Is the strategy currently in a winning streak or a drawdown? Tag each signal with 'last 10 trades had N% win rate'. Strategies often have regime-dependent performance clusters."},
            ].map((f,i) => (
              <div key={i} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:14}}>
                <div style={{fontSize:11,fontWeight:700,color:C.cyan,marginBottom:4}}>{f.name}</div>
                <div style={{fontSize:10,color:C.muted,lineHeight:1.7}}>{f.desc}</div>
              </div>
            ))}
          </div>
        </Box>

        <Box>
          <H>5.3 — What Additional Regime Statistics Would Help?</H>
          <P>Beyond the Spearman ρ, the following statistics would make the regime table far more actionable:</P>
          <P>• <Em>Bucket Sharpe SE</Em> — standard error for each bucket Sharpe. Computed as SR × √(2/n). If the SE is larger than the spread, the spread is noise.</P>
          <P>• <Em>Permutation p-value for spread</Em> — as described in section 4.1. This is the single most important missing statistic.</P>
          <P>• <Em>Effect size (Cohen's d)</Em> — standardised difference between best and worst bucket. d &gt; 0.5 is "medium" effect, d &gt; 0.8 is "large". More interpretable than raw spread.</P>
          <P>• <Em>IS→OOS bucket-level retention</Em> — not just rank correlation, but the actual Sharpe ratio of each bucket in both IS and OOS displayed side by side. This is already in the stability report but hidden behind a toggle — it should be promoted to the main table.</P>
          <P>• <Em>Filter impact simulation</Em> — for each feature, show: "if you had filtered out the worst bucket, how would portfolio OOS Sharpe change?" This turns abstract regime statistics into concrete P&L impact.</P>
        </Box>
      </div>)}

      {/* ═══ 6. SCANNER + LLM INTEGRATION ═══ */}
      {section === "integration" && (<div>
        <Box style={{marginBottom:16}}>
          <H>6.1 — Hourly Scanner → LLM Evolution Pipeline</H>
          <P>Your proposal: run the scanner every hour and feed results to the LLM Evolution Committee. This is the right architecture, but the implementation needs careful thought:</P>

          <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:14,margin:"8px 0",fontSize:10,lineHeight:1.8,color:C.muted}}>
            <div style={{fontWeight:700,color:C.gold,marginBottom:6}}>Hourly Cycle Design</div>
            <div>1. <Em c={C.cyan}>Scanner runs</Em> on latest data (rolling window). IS window creeps forward 1 hour.</div>
            <div>2. <Em c={C.cyan}>Regime analysis</Em> runs on OOS signals with all features + net position.</div>
            <div>3. <Em c={C.cyan}>Cumulative returns chart</Em> is computed showing portfolio equity curve up to this hour.</div>
            <div>4. <Em c={C.cyan}>Net position snapshot</Em> is captured and stored as a time series.</div>
            <div>5. <Em c={C.cyan}>Results package</Em> is assembled: OOS coin table + regime table + cumulative chart + net position.</div>
            <div>6. <Em c={C.cyan}>LLM Board receives</Em> the package as structured data (JSON), NOT as a screenshot or text dump.</div>
            <div>7. <Em c={C.cyan}>Board proposes</Em> a modification based on the data.</div>
            <div>8. <Em c={C.cyan}>Modification is tested</Em> on the blind OOS window.</div>
            <div>9. <Em c={C.cyan}>If OOS Sharpe improves ≥5%</Em>, deploy to live signal generation.</div>
          </div>
        </Box>

        <Box style={{marginBottom:16}}>
          <H>6.2 — What The LLM Board Needs From The Scanner</H>
          <P>The board should receive a structured JSON report each hour containing:</P>

          <div style={{background:C.bg,border:`1px solid ${C.cyan}25`,borderRadius:6,padding:14,margin:"8px 0",fontSize:10,lineHeight:1.8,color:C.muted}}>
            <code style={{display:"block",whiteSpace:"pre-wrap",color:C.text,fontSize:9}}>{`{
  "timestamp": "2026-02-23T14:00:00Z",
  "scannerResults": {
    "winnerStrategy": { ... },
    "oosAvgSharpe": 3.96,
    "oosConsistency": "13/20",
    "perCoinOOS": [ { "coin":"ZEC", "sharpe":16.2, ... } ],
    "cumulativeReturn": 2.58
  },
  "regimeFeatures": [
    {
      "feature": "Vol State",
      "spread": 20.9,
      "rhoIStoOOS": 1.0,
      "rhoSignificant": true,
      "permutationP": 0.003,
      "buckets": [
        { "label":"COMPRESSED", "n":207, "sharpe":-10.0, "se":1.45 },
        { "label":"NORMAL", "n":1695, "sharpe":10.8, "se":0.37 },
        { "label":"EXPANDING", "n":286, "sharpe":-2.9, "se":1.2 }
      ],
      "filterImpact": "+1.8 SR if worst bucket excluded"
    }
  ],
  "netPosition": {
    "current": -3,
    "rollingAvg20bar": -1.7,
    "bucket": "moderate_short_bias"
  },
  "activeFilters": [
    { "rule":"skip_compressed_vol", "deployedAt":"...", "oosLift":"+12%" }
  ]
}`}</code>
          </div>
        </Box>

        <Box style={{marginBottom:16}}>
          <H>6.3 — Cumulative Chart & Per-Coin Drilldown</H>
          <P>Adding to the scanner page: after the scan completes, a cumulative return chart should render showing the composite portfolio equity curve across all 20 coins. This chart should:</P>
          <P>• Show the aggregate (equal-weight) cumulative return over the OOS period</P>
          <P>• Allow clicking on individual coins to see their individual equity curves</P>
          <P>• Include the net position as a secondary axis or overlay</P>
          <P>• Mark significant drawdown periods</P>
          <P>• Be generated from the actual OOS signal data already stored in <code>regimeOosSignals</code></P>
          <P>This is implementable because the scanner already stores all OOS signals with entry/exit indices and returns. The cumulative chart simply walks through the signals chronologically and accumulates returns.</P>
        </Box>

        <Box>
          <H>6.4 — Value Function For The LLM Board</H>
          <P>Your proposed value function is "maximise Sharpe ratio and win rate." These can conflict — a strategy that takes only the highest-conviction trades will have a high win rate but low Sharpe if it trades too infrequently (daily returns are mostly zero). Recommend:</P>
          <P><Em c={C.green}>Primary: OOS Sharpe ratio</Em> — this already balances return and risk. It penalises inactivity (zero-return days lower the mean relative to std).</P>
          <P><Em c={C.yellow}>Constraints (not objectives):</Em> win rate &gt; 50%, PF &gt; 1.1, ≥3 signals/coin/day, max drawdown &lt; 3%. These prevent degenerate solutions without creating a multi-objective problem.</P>
          <P><Em c={C.red}>Avoid:</Em> Weighted sum of Sharpe + win rate. This creates a poorly-defined optimisation landscape where the board can game the weights.</P>
        </Box>
      </div>)}
    </div>
  );
}

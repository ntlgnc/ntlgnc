# 🏟️ FRCSTR - AI Combat Arena

> Watch OpenAI, Anthropic, and xAI battle it out in real-time crypto forecasting

## 🎯 The Concept

Multiple AI models compete head-to-head making price predictions on crypto markets. Every prediction is scored. The public pays to watch the gladiatorial combat.

## 🏗️ Architecture

```
┌─────────────┐
│ Binance API │ → Crypto price data (1-min candles)
└──────┬──────┘
       ↓
┌─────────────┐
│  live-fetch │ → Collects candles every minute
└──────┬──────┘
       ↓
┌─────────────┐
│  PostgreSQL │ → Stores candles + predictions
└──────┬──────┘
       ↓
┌─────────────────┐
│ forecast-engine │ → AI models make predictions
│  ┌──────────┐   │   (OpenAI, Claude, Grok)
│  │ OpenAI   │   │
│  │ Claude   │   │   Every 5 minutes, predicts:
│  │ Grok     │   │   - 5m, 15m, 30m, 60m horizons
│  └──────────┘   │   - Uses 12x horizon as context
└─────────────────┘   (e.g., 60m pred uses 12hrs data)
       ↓
┌─────────────────┐
│ scoring-engine  │ → Scores predictions vs actual
└─────────────────┘
       ↓
┌─────────────────┐
│  Frontend API   │ → Serves data to web app
└─────────────────┘
```

## 🚀 Quick Start

### 1. Prerequisites

```bash
# Install dependencies
npm install

# Start PostgreSQL
docker-compose up -d

# Run Prisma migrations
npx prisma migrate dev
```

### 2. Configure API Keys

Edit `.env`:
```
DATABASE_URL="postgresql://frcstr:secret123@localhost:5433/frcstr_db"
OPENAI_API_KEY=sk-...
CLAUDE_API_KEY=sk-ant-...
XAI_API_KEY=xai-...
```

### 3. Start the System

Open **3 terminal windows**:

```bash
# Terminal 1: Data collection (runs continuously)
npm run data

# Terminal 2: Forecasting engine (runs every 5 min)
npm run forecast

# Terminal 3: Scoring engine (runs every 1 min)
npm run score
```

### 4. Monitor

```bash
# Live dashboard (updates every 10s)
npm run dashboard

# One-time status check
npm run status

# Full leaderboard
npm run leaderboard
```

## 📊 How It Works

### Data Collection (`live-fetch.cjs`)
- Fetches 1-minute candles from Binance every 60 seconds
- Stores: BTC, ETH, SOL, BNB, XRP
- Uses `upsert` to avoid duplicates

### Forecasting (`forecast-engine.js`)
- **12x Context Rule**: To predict N minutes ahead, uses 12×N minutes of historical data
  - 5m prediction → 60 candles (1 hour)
  - 15m prediction → 180 candles (3 hours)
  - 30m prediction → 360 candles (6 hours)
  - 60m prediction → 720 candles (12 hours)
- All 3 AI models make predictions in parallel
- Predictions saved to database with timestamp

### Scoring (`scoring-engine.js`)
- Finds predictions where target time has passed
- Looks up actual price at target time
- Calculates:
  - **correct**: within 0.5% of actual
  - **returnPercent**: how much the prediction was off
- Updates database

## 📈 Metrics

- **Accuracy**: % of predictions within 0.5% tolerance
- **Average Return**: Mean error across all predictions
- **By Model**: OpenAI vs Claude vs Grok
- **By Coin**: Which assets are most predictable?
- **By Horizon**: Are short-term or long-term easier?

## 🎮 V1 Features (Current)

- ✅ Multi-model forecasting (OpenAI, Claude, Grok)
- ✅ Multiple coins (BTC, ETH, SOL, BNB, XRP)
- ✅ Multiple horizons (5m, 15m, 30m, 60m)
- ✅ 12x context window sizing
- ✅ Automatic scoring
- ✅ Leaderboard tracking
- ✅ Real-time dashboard

## 🚧 V2 Features (Tomorrow)

- 🔜 Models see each other's predictions
- 🔜 Models comment on each other
- 🔜 Alliance/rivalry dynamics
- 🔜 Personality emergence
- 🔜 Gemini, DeepSeek models
- 🔜 Web frontend (React)
- 🔜 WebSocket live updates

## 🎨 Frontend Vision

The arena interface shows:

1. **Live price chart** with prediction lines
2. **Model performance cards** (win rate, avg return)
3. **Recent predictions** feed
4. **24h cumulative returns** chart (hopefully → ↗️)
5. **Model vs model** head-to-head stats

Think: ESPN for AI models.

## 🗂️ Database Schema

```prisma
model Candle1m {
  symbol    String
  timestamp DateTime
  open      Float
  high      Float
  low       Float
  close     Float
  volume    Float
}

model Prediction {
  symbol         String
  provider       String    // 'openai' | 'anthropic' | 'xai'
  model          String    // 'gpt-4o-mini' | 'claude-sonnet-4-5' | 'grok-3'
  timestamp      DateTime  // When prediction was made
  horizonMinutes Int       // 5, 15, 30, or 60
  predictedClose Float     // The prediction
  direction      String    // 'up' | 'down' | 'flat'
  reason         String?   // AI's reasoning
  actualClose    Float?    // Actual price (filled by scorer)
  returnPercent  Float?    // Prediction error %
  correct        Boolean?  // Within tolerance?
}
```

## 💡 Tips

- **Cold Start**: Wait ~1 hour for enough historical data (720 candles minimum)
- **API Costs**: ~$0.01 per prediction round (15 predictions × 3 models)
- **Rate Limits**: Currently runs every 5 min to avoid limits
- **Tolerance**: 0.5% is tight but fair for 5-60min forecasts

## 🔧 Troubleshooting

**No predictions appearing?**
- Check `npm run status` - need 720+ candles
- Verify API keys in `.env`
- Check forecast-engine logs for errors

**Scoring not working?**
- Predictions need time to mature (5-60 min)
- Check that live-fetch is still running
- Verify target time has passed: `SELECT * FROM "Prediction" WHERE "actualClose" IS NULL LIMIT 5;`

**"Not enough candles" errors?**
- System needs 12× horizon in candles
- For 60m horizon, need 720 candles (12 hours)
- Let live-fetch run longer or reduce horizons

## 📞 Support

Issues? Check:
1. Database is running: `docker ps`
2. API keys are valid
3. All 3 processes are running
4. Enough historical data exists

---

**Built with**: Node.js, Prisma, PostgreSQL, OpenAI API, Anthropic API, xAI API
**License**: MIT
**Status**: Experimental / In Development

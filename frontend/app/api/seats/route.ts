import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SEAT_CAP = 1_000_000;
const BASE_PRICE = 20; // $20/month
const DISCOUNT_PER_MONTH = 0.05; // 5% cumulative discount per additional month
const RESALE_FEE = 0.10; // 10% commission on resales

// Pricing: month 1 = $20, month 2 = $19, month 3 = $18, etc.
function calculatePrice(months: number): number {
  let total = 0;
  for (let i = 0; i < months; i++) {
    total += BASE_PRICE * (1 - i * DISCOUNT_PER_MONTH);
  }
  return Math.round(total * 100) / 100;
}

async function ensureSeatTables(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      owner_id TEXT NOT NULL,
      owner_email TEXT,
      purchased_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      months_bought INTEGER DEFAULT 1,
      price_paid FLOAT DEFAULT 0,
      -- marketplace
      for_sale BOOLEAN DEFAULT false,
      ask_price FLOAT,
      listed_at TIMESTAMPTZ,
      -- status
      active BOOLEAN DEFAULT true,
      transferred_from TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS seat_transactions (
      id SERIAL PRIMARY KEY,
      seat_id INTEGER REFERENCES seats(id),
      type TEXT NOT NULL, -- 'purchase', 'resale', 'expired'
      buyer_id TEXT,
      seller_id TEXT,
      amount FLOAT,
      commission FLOAT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  try {
    await client.query(`CREATE INDEX IF NOT EXISTS idx_seats_owner ON seats(owner_id, active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_seats_forsale ON seats(for_sale, active) WHERE for_sale = true`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_seats_expires ON seats(expires_at)`);
  } catch {}
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "status";
  const client = await pool.connect();

  try {
    await ensureSeatTables(client);

    if (action === "status") {
      // Global seat stats
      const { rows: [stats] } = await client.query(`
        SELECT 
          COUNT(*) FILTER (WHERE active AND expires_at > NOW()) as active_seats,
          COUNT(*) FILTER (WHERE for_sale AND active AND expires_at > NOW()) as for_sale,
          MIN(ask_price) FILTER (WHERE for_sale AND active AND expires_at > NOW()) as cheapest_seat,
          AVG(ask_price) FILTER (WHERE for_sale AND active AND expires_at > NOW()) as avg_ask
        FROM seats
      `);
      const activeSeats = parseInt(stats.active_seats) || 0;
      const remaining = SEAT_CAP - activeSeats;

      // Recent resale prices
      const { rows: recentSales } = await client.query(`
        SELECT amount, commission, created_at FROM seat_transactions 
        WHERE type = 'resale' ORDER BY created_at DESC LIMIT 5
      `);

      return NextResponse.json({
        cap: SEAT_CAP,
        activeSeats,
        remaining,
        forSale: parseInt(stats.for_sale) || 0,
        cheapestSeat: stats.cheapest_seat ? parseFloat(stats.cheapest_seat) : null,
        avgAsk: stats.avg_ask ? Math.round(parseFloat(stats.avg_ask) * 100) / 100 : null,
        pricing: {
          1: calculatePrice(1),
          3: calculatePrice(3),
          6: calculatePrice(6),
          12: calculatePrice(12),
        },
        recentSales,
      });
    }

    if (action === "my-seat") {
      const userId = searchParams.get("userId");
      if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

      const { rows } = await client.query(
        `SELECT id, purchased_at, expires_at, months_bought, price_paid, for_sale, ask_price, listed_at
         FROM seats WHERE owner_id = $1 AND active = true AND expires_at > NOW()
         ORDER BY expires_at DESC LIMIT 1`,
        [userId]
      );
      return NextResponse.json({ seat: rows[0] || null });
    }

    if (action === "marketplace") {
      const sort = searchParams.get("sort") || "price_asc";
      const orderBy = sort === "price_desc" ? "ask_price DESC" : 
                       sort === "expiry" ? "expires_at DESC" :
                       "ask_price ASC";
      const { rows } = await client.query(`
        SELECT id, ask_price, expires_at, listed_at,
               EXTRACT(EPOCH FROM (expires_at - NOW())) / 86400 as days_remaining
        FROM seats 
        WHERE for_sale = true AND active = true AND expires_at > NOW()
        ORDER BY ${orderBy} LIMIT 50
      `);
      return NextResponse.json({ seats: rows });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action } = body;
  const client = await pool.connect();

  try {
    await ensureSeatTables(client);

    if (action === "buy") {
      const { userId, email, months } = body;
      if (!userId || !months) return NextResponse.json({ error: "userId and months required" }, { status: 400 });
      if (![1, 3, 6, 12].includes(months)) return NextResponse.json({ error: "months must be 1, 3, 6, or 12" }, { status: 400 });

      // Check cap
      const { rows: [{ cnt }] } = await client.query(
        `SELECT COUNT(*)::int as cnt FROM seats WHERE active = true AND expires_at > NOW()`
      );
      if (cnt >= SEAT_CAP) {
        return NextResponse.json({ error: "All seats sold. Check the marketplace.", capped: true }, { status: 409 });
      }

      const price = calculatePrice(months);
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + months);

      const { rows: [seat] } = await client.query(
        `INSERT INTO seats (owner_id, owner_email, expires_at, months_bought, price_paid)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [userId, email, expiresAt, months, price]
      );

      await client.query(
        `INSERT INTO seat_transactions (seat_id, type, buyer_id, amount)
         VALUES ($1, 'purchase', $2, $3)`,
        [seat.id, userId, price]
      );

      return NextResponse.json({ seat, price });
    }

    if (action === "list-for-sale") {
      const { userId, seatId, askPrice } = body;
      if (!userId || !seatId || !askPrice) return NextResponse.json({ error: "Missing fields" }, { status: 400 });
      if (askPrice < 1) return NextResponse.json({ error: "Minimum ask price is $1" }, { status: 400 });

      const { rowCount } = await client.query(
        `UPDATE seats SET for_sale = true, ask_price = $1, listed_at = NOW()
         WHERE id = $2 AND owner_id = $3 AND active = true AND expires_at > NOW()`,
        [askPrice, seatId, userId]
      );
      if (rowCount === 0) return NextResponse.json({ error: "Seat not found or not yours" }, { status: 404 });

      return NextResponse.json({ listed: true, askPrice });
    }

    if (action === "unlist") {
      const { userId, seatId } = body;
      await client.query(
        `UPDATE seats SET for_sale = false, ask_price = null, listed_at = null
         WHERE id = $1 AND owner_id = $2`,
        [seatId, userId]
      );
      return NextResponse.json({ unlisted: true });
    }

    if (action === "buy-resale") {
      const { buyerId, buyerEmail, seatId } = body;
      if (!buyerId || !seatId) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

      // Atomic: check it's still for sale, transfer ownership
      await client.query("BEGIN");
      try {
        const { rows } = await client.query(
          `SELECT id, owner_id, ask_price, expires_at FROM seats
           WHERE id = $1 AND for_sale = true AND active = true AND expires_at > NOW()
           FOR UPDATE`,
          [seatId]
        );

        if (rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Seat no longer available" }, { status: 409 });
        }

        const seat = rows[0];
        if (seat.owner_id === buyerId) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "You already own this seat" }, { status: 400 });
        }

        const price = parseFloat(seat.ask_price);
        const commission = Math.round(price * RESALE_FEE * 100) / 100;

        // Transfer
        await client.query(
          `UPDATE seats SET owner_id = $1, owner_email = $2, for_sale = false, 
           ask_price = null, listed_at = null, transferred_from = $3
           WHERE id = $4`,
          [buyerId, buyerEmail, seat.owner_id, seatId]
        );

        await client.query(
          `INSERT INTO seat_transactions (seat_id, type, buyer_id, seller_id, amount, commission)
           VALUES ($1, 'resale', $2, $3, $4, $5)`,
          [seatId, buyerId, seat.owner_id, price, commission]
        );

        await client.query("COMMIT");

        return NextResponse.json({
          purchased: true,
          seatId,
          price,
          commission,
          sellerReceives: Math.round((price - commission) * 100) / 100,
          expiresAt: seat.expires_at,
        });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  } finally {
    client.release();
  }
}

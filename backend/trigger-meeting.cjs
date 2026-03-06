/**
 * Trigger a board meeting manually.
 * 
 * Usage (PowerShell):
 *   node backend/trigger-meeting.cjs
 * 
 * This bypasses the scheduler and the 30-min dedup guard.
 */

const { execSync } = require('child_process');
const path = require('path');

// We can't easily import an ES module from CJS, so we use a child process
// that runs a tiny inline ES module script
const boardPath = path.resolve(__dirname, 'llm-board.js');

const script = `
import('${boardPath.replace(/\\/g, '/')}').then(async (mod) => {
  // The runBoardMeeting function isn't exported, but we can trigger via the module's start()
  // Instead, let's directly call the pool and run the meeting
  console.log('[trigger] Manual meeting trigger...');
}).catch(err => {
  console.error('[trigger] Import failed:', err.message);
  process.exit(1);
});
`;

// Actually, the simplest approach: just call the API endpoint
const http = require('http');

const BASE = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

console.log(`\n  ╔═══════════════════════════════════════════╗`);
console.log(`  ║  NTLGNC — Manual Board Meeting Trigger    ║`);
console.log(`  ╚═══════════════════════════════════════════╝\n`);
console.log(`  Calling ${BASE}/api/board ...\n`);

const url = new URL('/api/board', BASE);

const req = http.request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (json.error) {
        console.log(`  ❌ Error: ${json.error}`);
      } else if (json.meeting) {
        console.log(`  ✅ Meeting triggered!`);
        console.log(`  Meeting #${json.meeting.roundNumber || '?'}`);
        console.log(`  Chair: ${json.meeting.chair || '?'}`);
        console.log(`  Decision: ${json.meeting.decision || 'pending...'}`);
      } else {
        console.log(`  Response:`, JSON.stringify(json, null, 2));
      }
    } catch {
      console.log(`  Response (${res.statusCode}):`, data.slice(0, 500));
    }
  });
});

req.on('error', (err) => {
  console.log(`  ❌ Connection failed: ${err.message}`);
  console.log(`  Is the Next.js server running on ${BASE}?`);
});

req.write(JSON.stringify({ action: 'triggerMeeting' }));
req.end();

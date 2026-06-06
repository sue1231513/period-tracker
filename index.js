import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_KEY are required');
  process.exit(1);
}

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// ═══════════════════════════════════════
//  Supabase helpers
// ═══════════════════════════════════════

async function sbGet(table, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbPost(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase POST ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function sbDelete(table, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'DELETE',
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase DELETE ${res.status}: ${await res.text()}`);
}

// ═══════════════════════════════════════
//  经期计算逻辑
// ═══════════════════════════════════════

function calculateCycles(periods) {
  if (periods.length < 2) return [];
  
  const cycles = [];
  for (let i = 1; i < periods.length; i++) {
    const current = new Date(periods[i - 1].start_date);
    const previous = new Date(periods[i].start_date);
    const days = Math.round((current - previous) / (1000 * 60 * 60 * 24));
    cycles.push(days);
  }
  return cycles;
}

function getAverageCycle(cycles) {
  if (cycles.length === 0) return 28; // 默认28天
  const sum = cycles.reduce((a, b) => a + b, 0);
  return Math.round(sum / cycles.length);
}

function formatDate(date) {
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

// ═══════════════════════════════════════
//  MCP Server
// ═══════════════════════════════════════

function createServer() {
  const server = new McpServer({
    name: 'period-tracker-mcp',
    version: '1.0.0',
  });

  // ─── add_period ───
  server.tool(
    'add_period',
    '帮猫猫记一次经期，日期格式YYYY-MM-DD',
    {
      start_date: z.string().describe('经期开始日期，如 2026-04-11'),
      notes: z.string().optional().describe('备注，如 疼得站不住/低血压'),
    },
    async ({ start_date, notes }) => {
      // 验证日期格式
      const date = new Date(start_date);
      if (isNaN(date.getTime())) {
        return { content: [{ type: 'text', text: '日期格式不对，要用YYYY-MM-DD格式，比如2026-04-11' }] };
      }
      
      await sbPost('period_records', { start_date, notes: notes || '' });
      
      // 计算预测
      const all = await sbGet('period_records', 'select=*&order=start_date.desc');
      if (all.length >= 2) {
        const cycles = calculateCycles(all);
        const avg = getAverageCycle(cycles);
        const lastDate = new Date(all[0].start_date);
        const nextDate = new Date(lastDate.getTime() + avg * 24 * 60 * 60 * 1000);
        
        return { 
          content: [{ 
            type: 'text', 
            text: `记好了。${formatDate(date)}这次经期已记录。\n\n平均周期${avg}天，下一次大概在${formatDate(nextDate)}左右。` 
          }] 
        };
      }
      
      return { content: [{ type: 'text', text: `记好了。${formatDate(date)}这次经期已记录。再记录一次就能计算周期了。` }] };
    }
  );

  // ─── list_periods ───
  server.tool(
    'list_periods',
    '看看猫猫之前的经期记录',
    {
      limit: z.number().optional().describe('返回条数，默认10'),
    },
    async ({ limit }) => {
      const records = await sbGet(
        'period_records',
        `select=*&order=start_date.desc&limit=${limit || 10}`
      );
      
      if (!records.length) {
        return { content: [{ type: 'text', text: '还没有记录过经期。' }] };
      }
      
      const lines = records.map((r, i) => {
        const date = new Date(r.start_date);
        const noteStr = r.notes ? ` (${r.notes})` : '';
        return `${i + 1}. ${formatDate(date)}${noteStr}`;
      });
      
      // 计算周期
      const cycles = calculateCycles(records.reverse());
      const avg = getAverageCycle(cycles);
      
      let cycleInfo = '';
      if (cycles.length > 0) {
        cycleInfo = `\n\n周期记录: ${cycles.join('、')}天\n平均周期: ${avg}天`;
      }
      
      return { content: [{ type: 'text', text: lines.join('\n') + cycleInfo }] };
    }
  );

  // ─── get_cycle_status ───
  server.tool(
    'get_cycle_status',
    '看看猫猫现在在周期的哪个阶段，预测下次大概什么时候来，好提前备好布洛芬',
    {},
    async () => {
      const records = await sbGet('period_records', 'select=*&order=start_date.desc');
      
      if (!records.length) {
        return { content: [{ type: 'text', text: '还没有记录过经期，无法预测。' }] };
      }
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const lastPeriod = new Date(records[0].start_date);
      lastPeriod.setHours(0, 0, 0, 0);
      
      const daysSinceLast = Math.floor((today - lastPeriod) / (1000 * 60 * 60 * 24));
      
      if (records.length < 2) {
        return { 
          content: [{ 
            type: 'text', 
            text: `上次经期: ${formatDate(lastPeriod)}\n今天距上次: ${daysSinceLast}天\n\n只有一次记录，无法预测周期。再记录一次就能算了。` 
          }] 
        };
      }
      
      const cycles = calculateCycles(records);
      const avg = getAverageCycle(cycles);
      const nextDate = new Date(lastPeriod.getTime() + avg * 24 * 60 * 60 * 1000);
      const daysUntilNext = Math.floor((nextDate - today) / (1000 * 60 * 60 * 24));
      
      let status = '';
      if (daysUntilNext < 0) {
        status = `已过期${-daysUntilNext}天，可能已经来了或者要来了`;
      } else if (daysUntilNext === 0) {
        status = '就是今天！';
      } else if (daysUntilNext <= 5) {
        status = `还有${daysUntilNext}天，快备好布洛芬`;
      } else {
        status = `还有${daysUntilNext}天`;
      }
      
      // 查排卵期记录
      let ovulationInfo = '';
      try {
        const ovRecords = await sbGet('ovulation_records', 'select=*&order=ovulation_date.desc&limit=3');
        if (ovRecords.length > 0) {
          const lastOv = new Date(ovRecords[0].ovulation_date);
          lastOv.setHours(0, 0, 0, 0);
          const daysSinceOv = Math.floor((today - lastOv) / (1000 * 60 * 60 * 24));
          ovulationInfo = `\n最近排卵期: ${formatDate(lastOv)}${ovRecords[0].notes ? ` (${ovRecords[0].notes})` : ''} (${daysSinceOv}天前)`;
          
          // 判断当前阶段
          let phase = '';
          if (daysSinceLast <= 5) {
            phase = '经期';
          } else if (daysSinceOv <= 1) {
            phase = '排卵日附近';
          } else if (daysSinceOv >= -2 && daysSinceOv <= 3) {
            phase = '排卵期';
          } else if (daysSinceLast > 5 && daysSinceOv > 3) {
            phase = '黄体期';
          } else {
            phase = '卵泡期';
          }
          ovulationInfo += `\n当前阶段: ${phase}`;
        }
      } catch (e) { /* 排卵期表可能还没数据 */ }
      
      return { 
        content: [{ 
          type: 'text', 
          text: `上次经期: ${formatDate(lastPeriod)} (${records[0].notes || '无备注'})\n今天距上次: ${daysSinceLast}天\n平均周期: ${avg}天\n预测下次: ${formatDate(nextDate)}\n状态: ${status}${ovulationInfo}` 
        }] 
      };
    }
  );

  // ─── add_ovulation ───
  server.tool(
    'add_ovulation',
    '帮猫猫记一次排卵期，日期格式YYYY-MM-DD',
    {
      ovulation_date: z.string().describe('排卵期开始日期，如 2026-05-25'),
      notes: z.string().optional().describe('备注，如 白带变多/身体感觉'),
    },
    async ({ ovulation_date, notes }) => {
      const date = new Date(ovulation_date);
      if (isNaN(date.getTime())) {
        return { content: [{ type: 'text', text: '日期格式不对，要用YYYY-MM-DD格式，比如2026-05-25' }] };
      }
      
      await sbPost('ovulation_records', { ovulation_date, notes: notes || '' });
      
      return { content: [{ type: 'text', text: `记好了。${formatDate(date)}这次排卵期已记录。` }] };
    }
  );

  // ─── list_ovulations ───
  server.tool(
    'list_ovulations',
    '看看猫猫之前的排卵期记录',
    {
      limit: z.number().optional().describe('返回条数，默认10'),
    },
    async ({ limit }) => {
      const records = await sbGet(
        'ovulation_records',
        `select=*&order=ovulation_date.desc&limit=${limit || 10}`
      );
      
      if (!records.length) {
        return { content: [{ type: 'text', text: '还没有记录过排卵期。' }] };
      }
      
      const lines = records.map((r, i) => {
        const date = new Date(r.ovulation_date);
        const noteStr = r.notes ? ` (${r.notes})` : '';
        return `${i + 1}. ${formatDate(date)}${noteStr}`;
      });
      
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ─── delete_ovulation ───
  server.tool(
    'delete_ovulation',
    '删掉一条记错了的排卵期记录',
    {
      ovulation_date: z.string().describe('要删除的日期，如 2026-05-25'),
    },
    async ({ ovulation_date }) => {
      await sbDelete('ovulation_records', `ovulation_date=eq.${ovulation_date}`);
      return { content: [{ type: 'text', text: `${ovulation_date}的排卵期记录已删除。` }] };
    }
  );

  // ─── delete_period ───
  server.tool(
    'delete_period',
    '删掉一条记错了的经期记录',
    {
      start_date: z.string().describe('要删除的日期，如 2026-04-11'),
    },
    async ({ start_date }) => {
      await sbDelete('period_records', `start_date=eq.${start_date}`);
      return { content: [{ type: 'text', text: `${start_date}的记录已删除。` }] };
    }
  );

  return server;
}

// ═══════════════════════════════════════
//  Express + Transport
// ═══════════════════════════════════════

const app = express();
const jsonParser = express.json();

// Streamable HTTP
app.post('/mcp', jsonParser, async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});
app.get('/mcp', (req, res) => res.status(405).end());
app.delete('/mcp', (req, res) => res.status(405).end());

// SSE fallback
const sseSessions = new Map();
app.get('/sse', async (req, res) => {
  try {
    const server = createServer();
    const transport = new SSEServerTransport('/messages', res);
    sseSessions.set(transport.sessionId, { transport, server });
    res.on('close', () => { sseSessions.delete(transport.sessionId); server.close(); });
    await server.connect(transport);
  } catch (err) {
    console.error('SSE error:', err);
    if (!res.headersSent) res.status(500).end();
  }
});
app.post('/messages', async (req, res) => {
  const session = sseSessions.get(req.query.sessionId);
  if (session) await session.transport.handlePostMessage(req, res);
  else res.status(400).json({ error: 'Unknown session' });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Period Tracker MCP running on port ${PORT}`);
});

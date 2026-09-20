// Natural language query assistant for the dashboard
// Answers questions like "total housekeeping revenue", "laundry sales", "revenue from host X", etc.
const { all, get } = require('./db');

// Parse user question and return SQL + answer
function answerQuestion(question) {
  const q = question.toLowerCase().trim();

  // Helper: format currency
  const money = (n, compact = false) => {
    if (!n) return '₹0';
    const abs = Math.abs(n);
    if (compact && abs >= 10000000) return '₹' + (abs/10000000).toFixed(2) + 'Cr';
    if (compact && abs >= 100000) return '₹' + (abs/100000).toFixed(2) + 'L';
    return '₹' + abs.toLocaleString('en-IN');
  };

  // Pattern matching for common questions

  // 1. Total revenue / income
  if (q.includes('total revenue') || q.includes('total income') || q.includes('total sales')) {
    const r = get(`SELECT
      coalesce(sum(CASE WHEN t.direction='in' THEN t.gross_amount END), 0) AS total,
      COUNT(*) AS cnt
      FROM transactions t
      JOIN categories c ON c.category_id = t.category_id
      WHERE c.kind='revenue' AND t.status='Posted'`);
    return {
      answer: `Total revenue is **${money(r.total, true)}** from ${r.cnt} transactions.`,
      data: r
    };
  }

  // 2. Total costs
  if ((q.includes('total cost') || q.includes('total expense') || q.includes('total spent')) && !q.includes('by')) {
    const r = get(`SELECT
      coalesce(sum(CASE WHEN t.direction='out' THEN t.gross_amount END), 0) AS total,
      COUNT(*) AS cnt
      FROM transactions t
      JOIN categories c ON c.category_id = t.category_id
      WHERE c.kind IN ('opex','cogs','other') AND t.status='Posted'`);
    return {
      answer: `Total operating costs are **${money(r.total, true)}** from ${r.cnt} transactions.`,
      data: r
    };
  }

  // 3. Net profit
  if (q.includes('net profit') || q.includes('profit') || q.includes('bottom line')) {
    const r = get(`SELECT
      coalesce(sum(CASE WHEN t.direction='in' THEN t.gross_amount END), 0) AS revenue,
      coalesce(sum(CASE WHEN t.direction='out' THEN t.gross_amount END), 0) AS costs
      FROM transactions t
      JOIN categories c ON c.category_id = t.category_id
      WHERE c.kind IN ('revenue','opex','cogs','other') AND t.status='Posted'`);
    const net = (r.revenue || 0) - (r.costs || 0);
    const margin = r.revenue ? (net / r.revenue * 100).toFixed(1) : 0;
    return {
      answer: `Net profit is **${money(net, true)}** (${margin}% margin).\n\nRevenue: ${money(r.revenue, true)} | Costs: ${money(r.costs, true)}`,
      data: r
    };
  }

  // 4. Housekeeping revenue
  if (q.includes('housekeeping')) {
    const r = get(`SELECT
      coalesce(sum(CASE WHEN t.direction='in' THEN t.gross_amount END), 0) AS total,
      COUNT(*) AS cnt,
      COUNT(DISTINCT DATE(t.txn_date)) AS days
      FROM transactions t
      JOIN categories c ON c.category_id = t.category_id
      WHERE (c.name LIKE '%housekeeping%' OR c.name LIKE '%cleaning%')
        AND t.direction='in' AND t.status='Posted'`);
    const daily = r.days ? (r.total / r.days).toFixed(0) : 0;
    return {
      answer: `Housekeeping revenue: **${money(r.total, true)}** from ${r.cnt} bookings (avg **₹${daily}**/day).`,
      data: r
    };
  }

  // 5. Laundry revenue
  if (q.includes('laundry')) {
    const r = get(`SELECT
      coalesce(sum(CASE WHEN t.direction='in' THEN t.gross_amount END), 0) AS total,
      COUNT(*) AS cnt,
      COUNT(DISTINCT DATE(t.txn_date)) AS days
      FROM transactions t
      JOIN categories c ON c.category_id = t.category_id
      WHERE c.name LIKE '%laundry%' AND t.direction='in' AND t.status='Posted'`);
    const daily = r.days ? (r.total / r.days).toFixed(0) : 0;
    return {
      answer: `Laundry revenue: **${money(r.total, true)}** from ${r.cnt} transactions (avg **₹${daily}**/day).`,
      data: r
    };
  }

  // 6. Revenue by host
  if (q.includes('revenue by host') || q.includes('revenue each host') || q.includes('which host')) {
    const rows = all(`SELECT
      COALESCE(h.name, '(Unattributed)') AS host,
      COUNT(*) AS cnt,
      COALESCE(SUM(CASE WHEN t.direction='in' THEN t.gross_amount END), 0) AS revenue
      FROM transactions t
      LEFT JOIN properties pr ON pr.property_id = t.property_id
      LEFT JOIN hosts h ON h.host_id = pr.host_id
      WHERE t.direction='in' AND t.status='Posted'
      GROUP BY h.host_id
      ORDER BY revenue DESC
      LIMIT 10`);
    const total = rows.reduce((s, r) => s + r.revenue, 0);
    const lines = rows.map(r => `• **${r.host}**: ${money(r.revenue, true)} (${r.cnt} txns)`).join('\n');
    return {
      answer: `**Revenue by host**:\n\n${lines}\n\nTotal: **${money(total, true)}**`,
      data: rows
    };
  }

  // 7. Cost by category
  if (q.includes('cost by') || q.includes('expense by') || q.includes('where does money go')) {
    const rows = all(`SELECT
      c.name,
      COUNT(*) AS cnt,
      COALESCE(SUM(t.gross_amount), 0) AS amount
      FROM transactions t
      JOIN categories c ON c.category_id = t.category_id
      WHERE t.direction='out' AND t.status='Posted'
      GROUP BY c.category_id
      ORDER BY amount DESC
      LIMIT 12`);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const lines = rows.map(r => `• **${r.name}**: ${money(r.amount, true)} (${r.cnt} txns)`).join('\n');
    return {
      answer: `**Operating costs breakdown**:\n\n${lines}\n\nTotal: **${money(total, true)}**`,
      data: rows
    };
  }

  // 8. Number of properties/hosts
  if (q.includes('how many properties') || q.includes('number of properties') || q.includes('property count')) {
    const active = get(`SELECT COUNT(*) AS cnt FROM properties WHERE active=1`);
    const total = get(`SELECT COUNT(*) AS cnt FROM properties`);
    return {
      answer: `You have **${total.cnt} properties** in total, **${active.cnt} are active** right now.`,
      data: { active: active.cnt, total: total.cnt }
    };
  }

  // 9. Number of employees
  if (q.includes('how many employees') || q.includes('staff count') || q.includes('number of staff')) {
    const unique = get(`SELECT COUNT(DISTINCT staff_name) AS cnt FROM attendance`);
    const current = get(`SELECT COUNT(*) AS cnt FROM attendance WHERE strftime('%Y-%m', month) = strftime('%Y-%m', 'now')`);
    return {
      answer: `You have **${unique.cnt} employees** on record. **${current.cnt}** worked this month.`,
      data: unique
    };
  }

  // 10. GST collected
  if (q.includes('gst')) {
    const r = get(`SELECT
      COALESCE(SUM(cgst+sgst+igst), 0) AS total,
      COUNT(*) AS cnt
      FROM transactions
      WHERE status='Posted'`);
    return {
      answer: `Total GST in the system: **${money(r.total)}** across ${r.cnt} transactions.`,
      data: r
    };
  }

  // 11. Revenue this month/last month
  if (q.includes('this month') || q.includes('this month revenue')) {
    const r = get(`SELECT
      COALESCE(SUM(CASE WHEN t.direction='in' THEN t.gross_amount END), 0) AS total
      FROM transactions t
      WHERE t.status='Posted'
        AND strftime('%Y-%m', t.txn_date) = strftime('%Y-%m', 'now')`);
    return {
      answer: `Revenue this month so far: **${money(r.total, true)}**`,
      data: r
    };
  }

  // 12. Outstanding invoices
  if (q.includes('outstanding') || q.includes('money owed') || q.includes('pending payments')) {
    const r = get(`SELECT
      COUNT(*) AS cnt,
      COALESCE(SUM(total - received), 0) AS total
      FROM invoices
      WHERE (total - received) > 0`);
    return {
      answer: `**${r.cnt} invoices outstanding** for **${money(r.total, true)}** total.`,
      data: r
    };
  }

  // Fallback: generic search in narration
  if (q.length > 2) {
    const rows = all(`SELECT
      t.txn_date, t.gross_amount, t.direction,
      c.name AS category,
      COALESCE(p.display_name, '(no party)') AS party
      FROM transactions t
      LEFT JOIN categories c ON c.category_id = t.category_id
      LEFT JOIN parties p ON p.party_id = t.party_id
      WHERE t.narration LIKE ?
      ORDER BY t.txn_date DESC
      LIMIT 5`, [`%${q}%`]);

    if (rows.length > 0) {
      const lines = rows.map(r => `• ${r.txn_date}: **${r.party}** (${r.category}) ${r.direction==='in'?'+':'-'}${money(r.gross_amount)}`).join('\n');
      return {
        answer: `Found **${rows.length} transactions** matching "${question}":\n\n${lines}`,
        data: rows
      };
    }
  }

  // No match found
  return {
    answer: `I couldn't understand that question. Try asking things like:\n\n• "total revenue"\n• "total costs"\n• "net profit"\n• "housekeeping revenue"\n• "laundry sales"\n• "revenue by host"\n• "how many properties"\n• "outstanding invoices"`,
    data: null,
    error: true
  };
}

module.exports = { answerQuestion };

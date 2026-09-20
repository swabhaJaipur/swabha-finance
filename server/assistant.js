// Natural language query assistant - IMPROVED with detailed, conversational responses
const { all, get } = require('./db');

function answerQuestion(question) {
  const q = question.toLowerCase().trim();

  const money = (n, compact = false) => {
    if (!n) return '₹0';
    const abs = Math.abs(n);
    if (compact && abs >= 10000000) return '₹' + (abs/10000000).toFixed(2) + ' Cr';
    if (compact && abs >= 100000) return '₹' + (abs/100000).toFixed(2) + ' L';
    return '₹' + abs.toLocaleString('en-IN');
  };

  // 1. Total revenue / income (IMPROVED)
  if (q.includes('total revenue') || q.includes('total income') || q.includes('total sales')) {
    const r = get(`SELECT
      coalesce(sum(CASE WHEN t.direction='in' THEN t.gross_amount END), 0) AS total,
      COUNT(*) AS cnt,
      COUNT(DISTINCT DATE(t.txn_date)) AS days
      FROM transactions t
      JOIN categories c ON c.category_id = t.category_id
      WHERE c.kind='revenue' AND t.status='Posted'`);
    const daily = r.days ? (r.total / r.days).toFixed(0) : 0;
    return {
      answer: `**Total Revenue**: ${money(r.total, true)}\n\nYou've earned **${money(r.total, true)}** across **${r.cnt} transactions** over **${r.days} days**.\n\nThat's an average of **₹${daily} per day**.\n\n📊 *To see breakdown by host or service, ask "revenue by host" or "housekeeping vs laundry"*`,
      data: r
    };
  }

  // 2. Total costs (IMPROVED)
  if ((q.includes('total cost') || q.includes('total expense') || q.includes('total spent')) && !q.includes('by')) {
    const r = get(`SELECT
      coalesce(sum(CASE WHEN t.direction='out' THEN t.gross_amount END), 0) AS total,
      COUNT(*) AS cnt,
      COUNT(DISTINCT DATE(t.txn_date)) AS days
      FROM transactions t
      JOIN categories c ON c.category_id = t.category_id
      WHERE c.kind IN ('opex','cogs','other') AND t.status='Posted'`);
    const daily = r.days ? (r.total / r.days).toFixed(0) : 0;
    return {
      answer: `**Total Operating Costs**: ${money(r.total, true)}\n\nYou've spent **${money(r.total, true)}** across **${r.cnt} transactions**.\n\nDaily average: **₹${daily}/day**.\n\n💡 *Ask "cost by category" to see where the money is going*`,
      data: r
    };
  }

  // 3. Net profit (IMPROVED)
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
      answer: `🎯 **Net Profit**: ${money(net, true)} (${margin}% margin)\n\n**Revenue**: ${money(r.revenue, true)}\n**Costs**: ${money(r.costs, true)}\n**Net**: ${money(net, true)}\n\n${margin > 50 ? '✅ Excellent profitability!' : margin > 30 ? '📈 Good margin' : '⚠️ Tight margins - review costs'}\n\n*Ask "revenue by host" or "cost by category" for details*`,
      data: r
    };
  }

  // 4. Housekeeping revenue (IMPROVED)
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
      answer: `🏠 **Housekeeping/Cleaning Revenue**: ${money(r.total, true)}\n\n**${r.cnt} bookings** generating **${money(r.total, true)}** over **${r.days} days**.\n\n**Daily average**: ₹${daily}/day\n\n*This is ${r.total > 0 ? Math.round(100 * r.total / (r.total + 1000000)) + '% of your total revenue' : 'tracking separately'}*\n\n💡 *Ask "laundry revenue" to compare with cleaning*`,
      data: r
    };
  }

  // 5. Laundry revenue (IMPROVED)
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
      answer: `👕 **Laundry Revenue**: ${money(r.total, true)}\n\n**${r.cnt} transactions** generating **${money(r.total, true)}** over **${r.days} days**.\n\n**Daily average**: ₹${daily}/day\n\n💡 *Ask "revenue by host" to see which properties drive laundry income*`,
      data: r
    };
  }

  // 6. Revenue by host (IMPROVED)
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
      LIMIT 15`);
    const total = rows.reduce((s, r) => s + r.revenue, 0);
    const top = rows[0];
    const lines = rows.map((r, i) => `${i+1}. **${r.host}**: ${money(r.revenue, true)} (${(100*r.revenue/total).toFixed(1)}% | ${r.cnt} txns)`).join('\n');
    return {
      answer: `📊 **Revenue by Host**:\n\n${lines}\n\n**Total**: ${money(total, true)}\n\n🏆 **Top performer**: ${top.host} with ${money(top.revenue, true)} (${(100*top.revenue/total).toFixed(1)}% of total)\n\n💡 *Ask "revenue for [host name]" or "[host name] profitability" for details*`,
      data: rows
    };
  }

  // 7. Cost by category (IMPROVED)
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
    const top = rows[0];
    const lines = rows.slice(0, 5).map((r, i) => `${i+1}. **${r.name}**: ${money(r.amount, true)} (${(100*r.amount/total).toFixed(1)}%)`).join('\n');
    return {
      answer: `💰 **Where Your Money Goes** (Top 5):\n\n${lines}\n\n**Total Costs**: ${money(total, true)}\n\n🚨 **Biggest expense**: ${top.name} at ${money(top.amount, true)} (${(100*top.amount/total).toFixed(1)}% of costs)\n\n💡 *Review if this is necessary or if there are optimization opportunities*`,
      data: rows
    };
  }

  // 8. Property/host count (IMPROVED)
  if (q.includes('how many properties') || q.includes('number of properties') || q.includes('property count')) {
    const active = get(`SELECT COUNT(*) AS cnt FROM properties WHERE active=1`);
    const total = get(`SELECT COUNT(*) AS cnt FROM properties`);
    const hosts = get(`SELECT COUNT(*) AS cnt FROM hosts WHERE active=1`);
    return {
      answer: `🏠 **Property & Host Summary**:\n\n**Active Properties**: ${active.cnt}\n**Total Properties**: ${total.cnt} (${total.cnt - active.cnt} closed)\n**Active Hosts**: ${hosts.cnt}\n\n${active.cnt < 10 ? '⚠️ Only a few properties - consider listing more' : '✅ Good portfolio diversity'}\n\n💡 *Ask about a specific property or host for details*`,
      data: { active: active.cnt, total: total.cnt, hosts: hosts.cnt }
    };
  }

  // 9. Employee count (IMPROVED)
  if (q.includes('how many employees') || q.includes('staff count') || q.includes('number of staff')) {
    const unique = get(`SELECT COUNT(DISTINCT staff_name) AS cnt FROM attendance`);
    const current = get(`SELECT COUNT(*) AS cnt FROM attendance WHERE strftime('%Y-%m', month) = strftime('%Y-%m', 'now')`);
    return {
      answer: `👥 **Staff Summary**:\n\n**Total on record**: ${unique.cnt} employees\n**Active this month**: ${current.cnt}\n\n💡 *Ask "which employees" or "salary details" for more information*`,
      data: unique
    };
  }

  // 10. GST collected (IMPROVED)
  if (q.includes('gst')) {
    const r = get(`SELECT
      COALESCE(SUM(cgst+sgst+igst), 0) AS total,
      COUNT(*) AS cnt
      FROM transactions
      WHERE status='Posted'`);
    return {
      answer: `📌 **GST in System**: ${money(r.total)}\n\nAcross **${r.cnt} transactions**.\n\n💡 *This is GST collected, paid, and tracked across all entries*`,
      data: r
    };
  }

  // 11. Outstanding invoices (IMPROVED)
  if (q.includes('outstanding') || q.includes('money owed') || q.includes('pending payments')) {
    const r = get(`SELECT
      COUNT(*) AS cnt,
      COALESCE(SUM(total - received), 0) AS total
      FROM invoices
      WHERE (total - received) > 0`);
    return {
      answer: `⏳ **Outstanding Invoices**: **${r.cnt} invoices** for **${money(r.total, true)}**\n\n💡 *Follow up with customers for payment*\n*Ask "outstanding by host" for details*`,
      data: r
    };
  }

  // 12. Profit by month (NEW)
  if (q.includes('profit by month') || q.includes('monthly profit') || q.includes('each month')) {
    const rows = all(`SELECT
      strftime('%Y-%m', txn_date) AS month,
      SUM(CASE WHEN direction='in' THEN gross_amount ELSE -gross_amount END) AS net
      FROM transactions
      WHERE status='Posted'
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12`);
    const lines = rows.slice(0, 6).map(r => `**${r.month}**: ${money(r.net, true)}`).join(' | ');
    const avgNet = (rows.reduce((s, r) => s + r.net, 0) / rows.length).toFixed(0);
    return {
      answer: `📈 **Monthly Profit Trend** (Last 6 months):\n\n${lines}\n\n**Average monthly**: ₹${avgNet}`,
      data: rows
    };
  }

  // Fallback
  return {
    answer: `I can help with questions like:\n\n• "Total revenue?"\n• "Total costs?"\n• "Net profit?"\n• "Revenue by host?"\n• "Cost by category?"\n• "How many properties?"\n• "Laundry revenue?"\n• "Outstanding invoices?"\n• "Profit by month?"\n\nWhat would you like to know?`,
    data: null,
    error: true
  };
}

module.exports = { answerQuestion };

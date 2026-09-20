// Staff cost allocation to properties based on roster data
const { all, get, run } = require('./db');

// Calculate staff cost allocation per property
function allocateStaffCosts(month = null) {
  if (!month) {
    const now = new Date();
    month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  // Get all staff/salary entries for the month
  const salaries = all(`
    SELECT t.txn_id, t.party_id, t.gross_amount, p.display_name,
           t.property_id
    FROM transactions t
    LEFT JOIN parties p ON p.party_id = t.party_id
    WHERE t.status='Posted' 
      AND strftime('%Y-%m', t.txn_date) = ?
      AND t.direction='out'
      AND t.category_id IN (
        SELECT category_id FROM categories 
        WHERE name LIKE '%salary%' OR name LIKE '%staff%'
      )
    ORDER BY t.gross_amount DESC
  `, [month]);

  // Get attendance records for the month to determine property allocation
  const attendance = all(`
    SELECT DISTINCT staff_name, property_id
    FROM attendance
    WHERE strftime('%Y-%m', month) = ?
      AND property_id IS NOT NULL
  `, [month]);

  // Build allocation matrix
  const allocations = {};
  
  salaries.forEach(salary => {
    const staffName = salary.display_name;
    const salary_amount = salary.gross_amount;
    
    // Find properties worked by this staff
    const properties = attendance.filter(a => 
      a.staff_name.toLowerCase().includes(staffName.toLowerCase()) ||
      staffName.toLowerCase().includes(a.staff_name.toLowerCase())
    ).map(a => a.property_id);

    if (properties.length > 0) {
      const perProperty = salary_amount / properties.length;
      properties.forEach(prop => {
        if (!allocations[prop]) allocations[prop] = 0;
        allocations[prop] += perProperty;
      });
    }
  });

  return { month, allocations, salaries: salaries.length, properties: Object.keys(allocations).length };
}

// Get staff costs for a specific property
function getPropertyStaffCost(propertyId, month = null) {
  if (!month) {
    const now = new Date();
    month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  // Find staff working at this property
  const staff = all(`
    SELECT DISTINCT attendance.staff_name
    FROM attendance
    WHERE property_id = ? AND strftime('%Y-%m', month) = ?
  `, [propertyId, month]);

  if (staff.length === 0) return 0;

  // Get salary entries for these staff members
  let total = 0;
  staff.forEach(s => {
    const salary = get(`
      SELECT COALESCE(SUM(t.gross_amount), 0) as total
      FROM transactions t
      JOIN parties p ON p.party_id = t.party_id
      WHERE t.status='Posted'
        AND strftime('%Y-%m', t.txn_date) = ?
        AND t.direction='out'
        AND t.category_id IN (SELECT category_id FROM categories WHERE name LIKE '%salary%')
        AND p.display_name LIKE ?
    `, [month, `%${s.staff_name}%`]);
    
    if (salary && salary.total) {
      // Divide equally by properties
      const numProperties = all(`
        SELECT COUNT(DISTINCT property_id) as cnt
        FROM attendance
        WHERE staff_name = ? AND strftime('%Y-%m', month) = ?
      `, [s.staff_name, month])[0].cnt || 1;
      
      total += salary.total / numProperties;
    }
  });

  return total;
}

module.exports = { allocateStaffCosts, getPropertyStaffCost };

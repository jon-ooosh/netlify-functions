// get-job-details-v2.js - FIXED: Enhanced excess detection including "xs" abbreviation handling
const fetch = require('node-fetch');
const { checkMondayExcessStatus } = require('./monday-excess-checker');

// Generate hash from job data for URL security (keeping your existing pseudo-hash system)
function generateJobHash(jobId, jobData) {
  const userId = jobData.USER || '';
  const durationHrs = jobData.DURATION_HRS || '';
  const jobRef = jobId;
  const expectedHash = `${userId}${durationHrs}${jobRef}`;
  return expectedHash;
}

// Validate provided hash against job data
function validateJobHash(jobId, jobData, providedHash) {
  const userId = jobData.USER || '';
  const durationHrs = jobData.DURATION_HRS || '';
  const jobRef = jobId;
  const expectedHash = `${userId}${durationHrs}${jobRef}`;
  console.log(`Hash validation - Expected: ${expectedHash}, Provided: ${providedHash}`);
  return expectedHash === providedHash;
}

// Function to check if vans are on hire and count them properly including quantities
async function getVanInfo(jobId, hirehopDomain, token) {
  const vehicleCategoryIds = [369, 370, 371];
  const actualVanCategoryId = 370;
  
  try {
    const encodedToken = encodeURIComponent(token);
    const itemsUrl = `https://${hirehopDomain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodedToken}`;
    
    const response = await fetch(itemsUrl);
    
    if (!response.ok) {
      console.error('Failed to fetch job items');
      return { hasVans: false, vanCount: 0, vehicles: [] };
    }
    
    const responseText = await response.text();
    
    let jobItems;
    try {
      jobItems = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse job items JSON:', parseError);
      return { hasVans: false, vanCount: 0, vehicles: [] };
    }
    
    const items = Array.isArray(jobItems) ? jobItems : (jobItems.items || []);
    
    if (items.length > 0) {
      const vehicles = items.filter(item => 
        vehicleCategoryIds.includes(parseInt(item.CATEGORY_ID))
      );
      
      // Count ONLY actual vans (category 370 and not virtual) INCLUDING quantities
      const actualVans = items.filter(item => {
        const categoryId = parseInt(item.CATEGORY_ID);
        const isVirtual = item.VIRTUAL === "1";
        return categoryId === actualVanCategoryId && !isVirtual;
      });
      
      // Calculate total van count including quantities from each line item
      let totalVanCount = 0;
      actualVans.forEach(van => {
        const quantity = parseInt(van.qty || van.QTY || van.quantity || van.QUANTITY || 1);
        totalVanCount += quantity;
        console.log(`Van: ${van.NAME || van.name}, Category: ${van.CATEGORY_ID}, Quantity: ${quantity}, Virtual: ${van.VIRTUAL}`);
      });
      
      console.log(`Van detection debug - Job ${jobId}:`);
      console.log(`- Total vehicle items: ${vehicles.length}`);
      console.log(`- Actual vans (cat 370, non-virtual): ${actualVans.length} line items`);
      console.log(`- Total van count including quantities: ${totalVanCount}`);
      
      return {
        hasVans: totalVanCount > 0,
        vanCount: totalVanCount,
        vehicles: vehicles,
        actualVans: actualVans
      };
    }
    
    return { hasVans: false, vanCount: 0, vehicles: [] };
  } catch (error) {
    console.error('Error checking van on hire:', error);
    return { hasVans: false, vanCount: 0, vehicles: [] };
  }
}

// Function to determine excess payment timing
function determineExcessPaymentTiming(startDate, endDate) {
  const now = new Date();
  const hireStart = new Date(startDate);
  const hireEnd = new Date(endDate);
  
  const hireDays = Math.ceil((hireEnd - hireStart) / (1000 * 60 * 60 * 24));
  const daysFromNowToEnd = Math.ceil((hireEnd - now) / (1000 * 60 * 60 * 24));
  
  console.log(`Excess timing logic:`);
  console.log(`- Hire days: ${hireDays}`);
  console.log(`- Days from now to hire end: ${daysFromNowToEnd}`);
  console.log(`- Now: ${now.toDateString()}`);
  console.log(`- Hire start: ${hireStart.toDateString()}`);
  console.log(`- Hire end: ${hireEnd.toDateString()}`);
  
  // Rule: Only short hires (≤4 days) can use pre-auth
  // AND we can only hold pre-auth for max 5 days
  if (hireDays <= 4) {
    console.log(`- Short hire (≤4 days), checking if we can hold pre-auth...`);
    
    if (daysFromNowToEnd > 5) {
      console.log(`- Too early: Can't hold pre-auth for ${daysFromNowToEnd} days (max 5)`);
      return {
        method: 'too_early',
        description: `Pre-authorization available closer to hire date (can only hold for 5 days)`,
        canPreAuth: false,
        hireDays: hireDays,
        showOption: true,
        alternativeMessage: 'You can pay now via bank transfer or return closer to your hire date for card pre-authorization'
      };
    } else if (daysFromNowToEnd >= 0) {
      console.log(`- Perfect timing: Can hold pre-auth for ${daysFromNowToEnd} days`);
      return {
        method: 'pre-auth',
        description: 'Pre-authorization (held but not charged unless needed)',
        canPreAuth: true,
        hireDays: hireDays,
        showOption: true
      };
    } else {
      console.log(`- Too late: Hire has ended`);
      return {
        method: 'too_late',
        description: 'Hire period has ended - excess payment now required as regular payment',
        canPreAuth: false,
        hireDays: hireDays,
        showOption: true
      };
    }
  } else {
    console.log(`- Long hire (>4 days), using regular payment`);
    return {
      method: 'payment',
      description: 'Insurance excess payment (refundable after hire)',
      canPreAuth: false,
      canPayNow: true,
      hireDays: hireDays,
      showOption: true
    };
  }
}

// 🔧 FIXED: Helper function to determine if an invoice should be counted towards amounts owed
function shouldCountInvoice(invoice) {
  // Only count invoices that are:
  // 1. Approved/Paid (status > 0, typically 1 = approved, 2 = paid)
  // 2. NOT proforma invoices
  
  const status = invoice.status || 0;
  const description = (invoice.desc || '').toLowerCase();
  
  // Skip proforma invoices (they're just estimates)
  if (description.includes('proforma') || description.includes('pro forma')) {
    console.log(`📋 SKIPPING proforma invoice: ${invoice.number} - "${invoice.desc}" (status: ${status})`);
    return false;
  }
  
  // Only count approved/paid invoices (status > 0)
  // Status 0 = draft/unpaid, Status 1+ = approved/paid
  if (status > 0) {
    console.log(`✅ COUNTING invoice: ${invoice.number} - "${invoice.desc}" (status: ${status}, amount: £${invoice.debit})`);
    return true;
  } else {
    console.log(`📋 SKIPPING unpaid invoice: ${invoice.number} - "${invoice.desc}" (status: ${status})`);
    return false;
  }
}

exports.handler = async (event, context) => {
  try {
    console.log('Function started - getting parameters');
    
    const params = new URLSearchParams(event.queryStringParameters);
    const jobId = params.get('jobId') || params.get('job');
    const hash = params.get('hash');
    
    console.log(`JobId: ${jobId}, Hash: ${hash}`);
    
    if (!jobId) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Job ID is required' })
      };
    }
    
    console.log('Getting environment variables');
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!token) {
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'HireHop API token not configured' })
      };
    }
    
    console.log('Fetching job data');
    const encodedToken = encodeURIComponent(token);
    const jobDataUrl = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
    const jobDataResponse = await fetch(jobDataUrl);
    
    if (!jobDataResponse.ok) {
      console.error('Job data fetch failed:', jobDataResponse.status);
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Failed to fetch job data' })
      };
    }
    
    const jobData = await jobDataResponse.json();
    console.log('Job data received, status:', jobData.STATUS);
    
    if (jobData.error) {
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'HireHop API error: ' + jobData.error })
      };
    }
    
    // Helper function to get status text with proper logic
    function getStatusText(statusCode) {
      const statusMap = {
        0: 'Enquiry',
        1: 'Provisional', 
        2: 'Booked',
        3: 'Booked', // Prepped -> Booked
        4: 'Booked', // Part Dispatched -> Booked  
        5: 'Booked', // Dispatched -> Booked
        6: 'Booked', // Returned Incomplete -> Booked
        7: 'Completed', // Returned -> Completed
        8: 'Booked', // Requires Attention -> Booked
        9: 'Cancelled',
        10: 'Not Interested',
        11: 'Completed'
      };
      return statusMap[statusCode] || `Unknown (${statusCode})`;
    }
    
    // Check if status should block access
    function shouldBlockAccess(statusCode) {
      return statusCode === 9 || statusCode === 10;
    }
    
    // Check if we should block access to cancelled/not interested jobs
    if (shouldBlockAccess(jobData.STATUS)) {
      return {
        statusCode: 403,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ 
          error: 'Access denied', 
          message: 'This job has been cancelled or is no longer available for payment.',
          status: getStatusText(jobData.STATUS)
        })
      };
    }
    
    // If hash is provided, validate it
    if (hash) {
      const isValidHash = validateJobHash(jobId, jobData, hash);
      
      if (!isValidHash) {
        return {
          statusCode: 403,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({ error: 'Invalid authentication hash' })
        };
      }
    } else {
      // If no hash provided, generate one and return it for the client to use
      const generatedHash = generateJobHash(jobId, jobData);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          success: true,
          message: 'Hash required for security',
          jobId: parseInt(jobId),
          hash: generatedHash,
          redirectUrl: `${event.headers.referer || 'payment.html'}?jobId=${jobId}&hash=${generatedHash}`,
          authenticated: false
        })
      };
    }
    
    console.log('Getting van info');
    const vanInfo = await getVanInfo(jobId, hirehopDomain, token);
    
    console.log('Calculating hire duration');
    const startDate = jobData.JOB_DATE || jobData.job_start ? new Date(jobData.JOB_DATE || jobData.job_start) : null;
    const endDate = jobData.JOB_END || jobData.job_end ? new Date(jobData.JOB_END || jobData.job_end) : null;
    let hireDays = null;

    if (startDate && endDate) {
      hireDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    }

    if (!hireDays && jobData.DURATION_DAYS) {
      hireDays = parseInt(jobData.DURATION_DAYS);
    }
    
    console.log('Getting billing data');
    const billingUrl = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
    const billingResponse = await fetch(billingUrl);
    
    if (!billingResponse.ok) {
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Failed to fetch billing data' })
      };
    }
    
    const billingData = await billingResponse.json();
    
    if (billingData.error) {
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'HireHop billing API error: ' + billingData.error })
      };
    }
    
    console.log('Processing billing data');
    
    // 🔧 ENHANCED: Helper function to detect if a payment is for insurance excess
    function isExcessPayment(deposit) {
      const desc = (deposit.desc || '').toLowerCase();
      
      // 🔧 ENHANCED: Added comprehensive "xs" pattern matching
      const hasExcessKeywords = desc.includes('excess') || 
                               desc.includes('insurance') ||
                               desc.includes('top up') ||
                               // 🔧 NEW: Handle "xs" patterns (comprehensive matching)
                               desc.includes(' xs ') ||     // " xs " (surrounded by spaces)
                               desc.includes(' xs') ||      // " xs" (space before, end of string)
                               desc.includes('xs ') ||      // "xs " (start of string, space after)
                               desc.match(/\bxs\b/) ||      // "xs" as whole word boundary
                               desc.includes('xs refund') || // "xs refund" 
                               desc.includes('refund xs') || // "refund xs"
                               desc.includes('- xs') ||     // "- xs" (common in descriptions)
                               desc.includes('xs -');       // "xs -" (alternative format)
      
      console.log(`🔍 Excess detection for "${desc}": ${hasExcessKeywords ? 'MATCH' : 'NO MATCH'}`);
      return hasExcessKeywords;
    }
    
    // 🔧 FIXED: Process billing data with enhanced excess detection and refund handling
    let totalJobValueExVAT = 0;
    let netHireDeposits = 0; // 🔧 NEW: Net amount (positive deposits - refunds)
    let netExcessDeposits = 0; // 🔧 NEW: Net amount (positive deposits - refunds)
    let totalApprovedInvoices = 0;
    let totalAllInvoices = 0;
    let hireDeposits = [];
    let excessDeposits = [];
    let approvedInvoices = [];
    let skippedInvoices = [];
    let payments = [];
    let refunds = []; // 🔧 NEW: Track refunds separately
    
    console.log(`📋 BILLING ANALYSIS: Processing ${billingData.rows?.length || 0} billing rows...`);
    
    for (const row of billingData.rows || []) {
      console.log(`📋 Processing row: kind=${row.kind}, debit=${row.debit || 0}, credit=${row.credit || 0}, desc="${row.desc || ''}", number="${row.number || ''}, data=${JSON.stringify(row.data || {})}`);
      
      switch (row.kind) {
        case 0: // Job total (ex-VAT)
          totalJobValueExVAT = row.accrued || 0;
          console.log(`📋 Job value ex-VAT: £${totalJobValueExVAT.toFixed(2)}`);
          break;
          
        case 1: // Invoice
          totalAllInvoices += row.debit || 0;
          
          // Only count approved/paid invoices, skip proformas
          if (shouldCountInvoice(row)) {
            totalApprovedInvoices += row.debit || 0;
            approvedInvoices.push({
              id: row.id,
              number: row.number,
              date: row.date,
              amount: row.debit,
              owing: row.owing,
              status: row.status,
              description: row.desc
            });
          } else {
            skippedInvoices.push({
              id: row.id,
              number: row.number,
              date: row.date,
              amount: row.debit,
              owing: row.owing,
              status: row.status,
              description: row.desc,
              reason: row.desc?.toLowerCase().includes('proforma') ? 'proforma' : 'unpaid'
            });
          }
          break;
          
        case 6: // Deposit/Payment
          const creditAmount = row.credit || 0;
          
          const depositInfo = {
            id: row.id,
            number: row.number,
            date: row.date,
            amount: creditAmount, // 🔧 NEW: This can now be negative for refunds
            description: row.desc,
            owing: row.owing,
            enteredBy: row.data?.CREATE_USER_NAME,
            bankAccount: row.data?.ACC_ACCOUNT_ID,
            bankName: billingData.banks?.find(b => b.ID === row.data?.ACC_ACCOUNT_ID)?.NAME,
            isRefund: creditAmount < 0 // 🔧 NEW: Flag refunds
          };
          
          // 🔧 ENHANCED: Handle both positive payments and negative refunds with improved excess detection
          if (isExcessPayment(row)) {
            netExcessDeposits += creditAmount; // Add to net (can be negative)
            excessDeposits.push({
              ...depositInfo,
              type: 'excess'
            });
            
            if (creditAmount < 0) {
              console.log(`💸 EXCESS REFUND DETECTED: ${row.number} - £${Math.abs(creditAmount).toFixed(2)} refunded - Description: "${row.desc}"`);
            } else {
              console.log(`💰 EXCESS PAYMENT: ${row.number} - £${creditAmount.toFixed(2)} received - Description: "${row.desc}"`);
            }
          } else {
            netHireDeposits += creditAmount; // Add to net (can be negative)
            hireDeposits.push({
              ...depositInfo,
              type: 'hire'
            });
            
            if (creditAmount < 0) {
              console.log(`💸 HIRE REFUND: ${row.number} - £${Math.abs(creditAmount).toFixed(2)} refunded`);
              refunds.push({
                ...depositInfo,
                type: 'hire_refund'
              });
            } else {
              console.log(`💰 HIRE PAYMENT: ${row.number} - £${creditAmount.toFixed(2)} received`);
            }
          }
          break;
          
        case 3: // Payment
          const paymentAmount = row.credit || 0;
          payments.push({
            id: row.id,
            date: row.date,
            amount: paymentAmount,
            description: row.desc,
            owner: row.owner,
            isRefund: paymentAmount < 0 // 🔧 NEW: Flag negative payments as refunds
          });
          
          // 🔧 NEW: Also add to net totals if it's related to hire/excess
          if (isExcessPayment(row)) {
            netExcessDeposits += paymentAmount;
            console.log(`📊 EXCESS PAYMENT (kind 3): ${row.desc} - £${paymentAmount.toFixed(2)}`);
          } else {
            netHireDeposits += paymentAmount;
          }
          break;
          
        case 2: // 🔧 NEW: Credit notes (if they exist as separate entries)
          const creditAmount2 = -(row.debit || 0); // Credit notes are usually negative debits
          
          if (isExcessPayment(row)) {
            netExcessDeposits += creditAmount2;
            console.log(`📝 EXCESS CREDIT NOTE: ${row.number} - £${Math.abs(creditAmount2).toFixed(2)}`);
          } else {
            netHireDeposits += creditAmount2;
            console.log(`📝 HIRE CREDIT NOTE: ${row.number} - £${Math.abs(creditAmount2).toFixed(2)}`);
            refunds.push({
              id: row.id,
              number: row.number,
              date: row.date,
              amount: creditAmount2,
              description: row.desc,
              type: 'credit_note'
            });
          }
          break;
      }
    }
    
    // 🔧 ENHANCED: Detailed billing debug logging with refund tracking
    console.log(`📋 BILLING SUMMARY (WITH ENHANCED EXCESS DETECTION):`);
    console.log(`- Job value ex-VAT: £${totalJobValueExVAT.toFixed(2)}`);
    console.log(`- All invoices total: £${totalAllInvoices.toFixed(2)} (${billingData.rows?.filter(r => r.kind === 1).length || 0} invoices)`);
    console.log(`- Approved invoices total: £${totalApprovedInvoices.toFixed(2)} (${approvedInvoices.length} invoices)`);
    console.log(`- Skipped invoices: £${(totalAllInvoices - totalApprovedInvoices).toFixed(2)} (${skippedInvoices.length} invoices)`);
    console.log(`- 🔧 NET hire deposits: £${netHireDeposits.toFixed(2)} (${hireDeposits.length} transactions)`);
    console.log(`- 🔧 NET excess deposits: £${netExcessDeposits.toFixed(2)} (${excessDeposits.length} transactions)`);
    console.log(`- Refunds processed: ${refunds.length} refund transactions`);
    
    // 🔧 NEW: Show detailed excess transaction breakdown
    if (excessDeposits.length > 0) {
      console.log(`📋 EXCESS TRANSACTION DETAILS:`);
      excessDeposits.forEach((deposit, index) => {
        console.log(`  ${index + 1}. ${deposit.number}: £${deposit.amount.toFixed(2)} - "${deposit.description}" ${deposit.isRefund ? '(REFUND)' : '(PAYMENT)'}`);
      });
    }
    
    // Show individual refunds for debugging
    if (refunds.length > 0) {
      console.log(`📋 REFUND DETAILS:`);
      refunds.forEach(refund => {
        console.log(`  - ${refund.number}: £${Math.abs(refund.amount).toFixed(2)} (${refund.type}) - "${refund.description}"`);
      });
    }
    
    if (skippedInvoices.length > 0) {
      console.log(`📋 SKIPPED INVOICES DETAILS:`);
      skippedInvoices.forEach(inv => {
        console.log(`  - ${inv.number}: £${(inv.amount || 0).toFixed(2)} (${inv.reason}) - "${inv.description}"`);
      });
    }
    
    // 🎯 NEW: Check Monday.com for excess status (for pre-auths and additional payments)
    console.log('🔍 Checking Monday.com for excess status...');
    const mondayExcessCheck = await checkMondayExcessStatus(jobId);
    
    // 🔧 FIXED: Enhanced excess payment status logic with stale detection
    let finalExcessPaid = netExcessDeposits; // 🔧 CHANGED: Use net amount
    let excessMethod = 'not_required';
    let excessDescription = 'No excess required';
    let excessSource = 'hirehop';
    
    if (mondayExcessCheck.found && mondayExcessCheck.mondayExcessData) {
      console.log('📋 Found Monday.com excess data:', mondayExcessCheck.mondayExcessData);
      
      // 🔧 FIXED: Only trust pre-auth completion if we have BOTH update AND column status
      // This prevents false positives when updates are deleted but column remains
      if (mondayExcessCheck.preAuthUpdate && mondayExcessCheck.excessStatus === 'Pre-auth taken') {
        // We have BOTH the update text AND the column status - this is genuine
        console.log('✅ VERIFIED PRE-AUTH: Found both update and column status');
        excessMethod = 'pre-auth_completed';
        excessDescription = 'Pre-authorization completed (verified via Monday.com update + column)';
        excessSource = 'monday.com';
        // Don't add to finalExcessPaid as pre-auths aren't "paid"
      } else if (mondayExcessCheck.preAuthUpdate && !mondayExcessCheck.excessStatus) {
        // We have update but no column status - this shouldn't happen but handle it
        console.log('⚠️ PARTIAL PRE-AUTH: Update found but no column status');
        excessMethod = 'pre-auth_completed';
        excessDescription = 'Pre-authorization completed (via Monday.com update only)';
        excessSource = 'monday.com';
      } else if (!mondayExcessCheck.preAuthUpdate && mondayExcessCheck.excessStatus === 'Pre-auth taken') {
        // Column says pre-auth taken but no update found - this is the bug case!
        console.log('🚨 STALE COLUMN: Column shows pre-auth but no update found - treating as incomplete');
        excessMethod = 'column_only_stale';
        excessDescription = 'Column shows pre-auth taken but no verification update found';
        excessSource = 'monday.com_stale';
        // Don't mark as completed - this is likely a stale column value
      } else if (mondayExcessCheck.excessStatus === 'Excess paid') {
        console.log('💰 EXCESS PAID: Regular excess payment detected');
        finalExcessPaid = Math.max(finalExcessPaid, mondayExcessCheck.mondayExcessData.paid);
        excessMethod = 'completed';
        excessDescription = 'Excess payment completed (via Monday.com record)';
        excessSource = 'monday.com';
      } else if (mondayExcessCheck.excessStatus === 'Retained from previous hire') {
        console.log('🔄 EXCESS RETAINED: Retained from previous hire');
        finalExcessPaid = Math.max(finalExcessPaid, 1200); // Assume standard £1200
        excessMethod = 'retained';
        excessDescription = 'Excess retained from previous hire';
        excessSource = 'monday.com';
      } else {
        console.log('📋 NO MONDAY EXCESS: No excess detected in Monday.com');
      }
    } else {
      console.log('📋 NO MONDAY DATA: Monday.com check failed or returned no data');
    }
    
    console.log(`📋 Final excess determination: Method="${excessMethod}", Source="${excessSource}", Description="${excessDescription}", Amount=£${finalExcessPaid.toFixed(2)}`);
    
    // 🔧 FIXED: Calculate totals with correct invoice logic and refund handling
    const totalJobValueIncVAT = totalJobValueExVAT * 1.2; // Add 20% VAT
    
    // 🎯 CRITICAL FIX: Always use job value as the total owed, NOT invoice totals
    // Invoices (especially proformas) are just billing instruments, not the actual amount owed
    const actualTotalOwed = totalJobValueIncVAT;
    
    // 🔧 FIXED: Calculate payment status using NET payments (payments - refunds)
    const totalHirePaid = netHireDeposits;
    const remainingHireBalance = actualTotalOwed - totalHirePaid;
    
    // Only consider overpaid if genuinely overpaid by more than 1 penny
    const isOverpaid = remainingHireBalance < -0.01;
    
    console.log('🎯 ENHANCED PAYMENT CALCULATION (WITH IMPROVED EXCESS DETECTION):');
    console.log(`- Total job value ex-VAT: £${totalJobValueExVAT.toFixed(2)}`);
    console.log(`- Total job value inc-VAT (calculated): £${totalJobValueIncVAT.toFixed(2)}`);
    console.log(`- All invoices total: £${totalAllInvoices.toFixed(2)}`);
    console.log(`- Approved invoices total: £${totalApprovedInvoices.toFixed(2)}`);
    console.log(`- 🎯 USING JOB VALUE as total owed: £${actualTotalOwed.toFixed(2)} (FIXED!)`);
    console.log(`- 🔧 NET hire paid (after refunds): £${totalHirePaid.toFixed(2)} (FIXED!)`);
    console.log(`- Remaining balance: ${actualTotalOwed.toFixed(2)} - ${totalHirePaid.toFixed(2)} = £${remainingHireBalance.toFixed(2)}`);
    console.log(`- 🔧 NET excess paid (after refunds): £${finalExcessPaid.toFixed(2)} (ENHANCED DETECTION!)`);
    console.log(`- Monday.com excess status: ${mondayExcessCheck.found ? mondayExcessCheck.excessStatus : 'Not found'}`);
    console.log(`- Final excess status: ${excessMethod} (source: ${excessSource})`);
    
    // Calculate deposit requirements based on business rules (using the job value)
    let requiredDeposit = Math.max(actualTotalOwed * 0.25, 100);
    if (actualTotalOwed < 400) {
      requiredDeposit = actualTotalOwed;
    }
    
    const depositPaid = totalHirePaid >= requiredDeposit;
    const fullyPaid = remainingHireBalance <= 0.01; // Allow for small rounding differences
    
    // Calculate excess requirements based on van count
    const excessPerVan = 1200; // £1,200 per van
    const totalExcessRequired = vanInfo.vanCount * excessPerVan;
    const excessPaid = finalExcessPaid > 0;
    const excessComplete = finalExcessPaid >= totalExcessRequired || excessMethod === 'pre-auth_completed' || excessMethod === 'retained';
    
    // 🔧 ENHANCED: Update the excess timing logic to handle the stale column case
    let excessPaymentTiming;
    
    if (excessMethod === 'pre-auth_completed' || excessMethod === 'completed' || excessMethod === 'retained') {
      // Already completed via Monday.com (verified)
      excessPaymentTiming = {
        method: excessMethod,
        description: excessDescription,
        canPreAuth: false,
        hireDays: hireDays,
        showOption: false, // Don't show payment option if already completed
        source: excessSource
      };
    } else if (excessMethod === 'column_only_stale') {
      // Stale column data - allow new payment but show warning
      console.log('⚠️ STALE COLUMN DETECTED: Allowing new payment despite stale column status');
      if (vanInfo.hasVans) {
        excessPaymentTiming = determineExcessPaymentTiming(
          jobData.JOB_DATE || jobData.job_start, 
          jobData.JOB_END || jobData.job_end
        );
        // Add warning about stale data
        excessPaymentTiming.staleWarning = 'Note: Column shows previous pre-auth but no verification found';
      } else {
        excessPaymentTiming = {
          method: 'not_required',
          description: 'No excess required',
          canPreAuth: false,
          hireDays: hireDays,
          showOption: false
        };
      }
    } else if (vanInfo.hasVans) {
      // Normal excess timing logic for jobs with vans
      excessPaymentTiming = determineExcessPaymentTiming(
        jobData.JOB_DATE || jobData.job_start, 
        jobData.JOB_END || jobData.job_end
      );
    } else {
      // No vans - no excess required
      excessPaymentTiming = {
        method: 'not_required',
        description: 'No excess required',
        canPreAuth: false,
        hireDays: hireDays,
        showOption: false
      };
    }
    
    console.log('Building response');
    
    // Construct the response
    const result = {
      success: true,
      jobId: parseInt(jobId),
      authenticated: true,
      jobData: {
        customerName: jobData.customer_name || jobData.CUSTOMER_NAME || jobData.NAME || '',
        customerEmail: jobData.customer_email || jobData.CUSTOMER_EMAIL || jobData.EMAIL || '',
        jobName: jobData.job_name || jobData.JOB_NAME || '',
        startDate: jobData.job_start || jobData.JOB_START || jobData.JOB_DATE || '',
        endDate: jobData.job_end || jobData.JOB_END || '',
        hireDays: hireDays || 'N/A',
        status: jobData.STATUS || null,
        statusText: getStatusText(jobData.STATUS),
        rawJobData: jobData
      },
      financial: {
        totalJobValueExVAT: totalJobValueExVAT,
        totalJobValueIncVAT: totalJobValueIncVAT,
        totalAllInvoices: totalAllInvoices,
        totalApprovedInvoices: totalApprovedInvoices,
        actualTotalOwed: actualTotalOwed, // 🔧 FIXED: Always use job value
        totalHirePaid: totalHirePaid, // 🔧 FIXED: Now net amount after refunds
        totalOwing: actualTotalOwed,
        remainingHireBalance: remainingHireBalance,
        isOverpaid: isOverpaid,
        overpaidAmount: isOverpaid ? Math.abs(remainingHireBalance) : 0,
        requiredDeposit: requiredDeposit,
        depositPaid: depositPaid,
        fullyPaid: fullyPaid,
        excessPaid: finalExcessPaid, // 🔧 FIXED: Combined HireHop + Monday.com (net with enhanced detection)
        excessComplete: excessComplete,
        currency: billingData.currency?.CODE || 'GBP'
      },
      excess: {
        amount: vanInfo.hasVans ? totalExcessRequired : 0,
        amountPerVan: excessPerVan,
        vanCount: vanInfo.vanCount,
        method: vanInfo.hasVans ? excessPaymentTiming.method : 'not_required',
        description: vanInfo.hasVans ? excessPaymentTiming.description : 'No excess required',
        canPreAuth: vanInfo.hasVans ? excessPaymentTiming.canPreAuth : false,
        showOption: vanInfo.hasVans ? excessPaymentTiming.showOption : false,
        alternativeMessage: vanInfo.hasVans ? excessPaymentTiming.alternativeMessage : null,
        availableFrom: vanInfo.hasVans ? excessPaymentTiming.availableFrom : null,
        alreadyPaid: finalExcessPaid,
        hasExcessPayments: excessPaid,
        vanOnHire: vanInfo.hasVans,
        hireDays: excessPaymentTiming.hireDays,
        vehicles: vanInfo.vehicles,
        source: excessSource,
        mondayStatus: mondayExcessCheck.found ? mondayExcessCheck.excessStatus : null,
        staleWarning: excessPaymentTiming.staleWarning || null
      },
      payments: {
        hireDeposits: hireDeposits,
        excessDeposits: excessDeposits,
        approvedInvoices: approvedInvoices,
        skippedInvoices: skippedInvoices,
        payments: payments,
        refunds: refunds, // 🔧 NEW: Show refunds separately
        summary: {
          totalHirePayments: hireDeposits.length,
          totalExcessPayments: excessDeposits.length,
          detectedExcessAmount: netExcessDeposits, // 🔧 CHANGED: Show net amount
          approvedInvoiceCount: approvedInvoices.length,
          skippedInvoiceCount: skippedInvoices.length,
          refundCount: refunds.length // 🔧 NEW
        }
      },
      mondayIntegration: {
        found: mondayExcessCheck.found,
        excessStatus: mondayExcessCheck.found ? mondayExcessCheck.excessStatus : null,
        itemId: mondayExcessCheck.found ? mondayExcessCheck.mondayItemId : null,
        hasStripeLink: mondayExcessCheck.found ? mondayExcessCheck.hasStripeLink : false
      },
      debug: {
        billingRows: billingData.rows?.length || 0,
        availableBanks: billingData.banks?.map(b => b.NAME) || [],
        generatedHash: generateJobHash(jobId, jobData),
        vanInfo: vanInfo,
        calculationBreakdown: {
          totalJobValueExVAT,
          totalJobValueIncVAT,
          totalAllInvoices,
          totalApprovedInvoices,
          actualTotalOwed,
          totalHirePaid, // 🔧 FIXED: Now net amount
          remainingHireBalance,
          netHireDeposits, // 🔧 NEW
          netExcessDeposits, // 🔧 NEW
          refundLogic: 'ENHANCED: Now handles negative credits, refunds, and "xs" abbreviations properly' // 🔧 NEW
        },
        mondayExcessCheck: mondayExcessCheck,
        excessDetectionEnhancement: 'Added comprehensive "xs" pattern matching for excess payment detection' // 🔧 NEW
      }
    };
    
    console.log('Returning success response');
    
   return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(result)
    };
    
  } catch (error) {
    console.error('Error in handler:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        success: false,
        error: 'Internal server error', 
        details: error.message,
        stack: error.stack
      })
    };
  }
};

// functions/get-admin-details.js - Get job details for admin interface with remaining claimable calculation
const fetch = require('node-fetch');
const { validateSessionToken } = require('./admin-auth');
const { checkMondayExcessStatus } = require('./monday-excess-checker');

exports.handler = async (event, context) => {
  try {
    // Set CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json'
    };

    // Handle preflight OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Preflight call successful' })
      };
    }

    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    // Get job ID from query parameters
    const params = new URLSearchParams(event.queryStringParameters);
    const jobId = params.get('jobId') || params.get('job');
    
    if (!jobId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Job ID is required' })
      };
    }
    
    console.log(`🔍 Admin details request for job ${jobId}`);
    
    // Validate session token
    const authHeader = event.headers.authorization;
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    if (!adminPassword) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Admin authentication not configured' })
      };
    }
    
    const tokenValidation = validateSessionToken(authHeader, adminPassword);
    
    if (!tokenValidation.valid) {
      console.log(`❌ Invalid admin token for job ${jobId}: ${tokenValidation.error}`);
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid or expired session', details: tokenValidation.error })
      };
    }
    
    console.log(`✅ Valid admin session for job ${jobId}, ${Math.round(tokenValidation.remainingTime / 1000 / 60)} minutes remaining`);
    
    // Get job details using existing function (bypass the hash requirement for admin)
    const jobDetails = await getJobDetailsForAdmin(jobId);
    
    if (!jobDetails.success) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Failed to load job details', 
          details: jobDetails.error 
        })
      };
    }
    
    // Get Monday.com excess status
    console.log('🔍 Checking Monday.com excess status for admin view...');
    const mondayExcessCheck = await checkMondayExcessStatus(jobId);
    
    // Enhanced admin response with additional metadata
    const adminResponse = {
      success: true,
      jobId: parseInt(jobId),
      authenticated: true,
      adminSession: {
        remainingTime: tokenValidation.remainingTime,
        expiresAt: new Date(tokenValidation.tokenData.expiry).toISOString()
      },
      jobData: jobDetails.jobData,
      financial: jobDetails.financial,
      excess: {
        ...jobDetails.excess,
        // Add admin-specific excess analysis
        adminAnalysis: analyzeExcessForAdmin(jobDetails, mondayExcessCheck)
      },
      payments: jobDetails.payments,
      mondayIntegration: {
        found: mondayExcessCheck.found,
        excessStatus: mondayExcessCheck.found ? mondayExcessCheck.excessStatus : null,
        itemId: mondayExcessCheck.found ? mondayExcessCheck.mondayItemId : null,
        hasStripeLink: mondayExcessCheck.found ? mondayExcessCheck.hasStripeLink : false,
        preAuthDetails: mondayExcessCheck.preAuthUpdate || null,
        rawMondayData: mondayExcessCheck // Full Monday.com data for admin debugging
      },
      availableActions: determineAvailableActions(jobDetails, mondayExcessCheck),
      debug: {
        ...jobDetails.debug,
        mondayExcessCheck: mondayExcessCheck,
        adminAccess: true,
        requestTime: new Date().toISOString()
      }
    };
    
    console.log(`✅ Admin details loaded successfully for job ${jobId}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(adminResponse)
    };
    
  } catch (error) {
    console.error('❌ Error in get-admin-details:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        error: 'Internal server error', 
        details: error.message,
        stack: error.stack
      })
    };
  }
};

// Get job details for admin (bypass hash requirement)
async function getJobDetailsForAdmin(jobId) {
  try {
    console.log(`📋 Fetching job details for admin access: ${jobId}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!token) {
      return { success: false, error: 'HireHop API token not configured' };
    }
    
    // Fetch job data from HireHop
    const encodedToken = encodeURIComponent(token);
    const jobDataUrl = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
    const jobDataResponse = await fetch(jobDataUrl);
    
    if (!jobDataResponse.ok) {
      return { success: false, error: 'Failed to fetch job data from HireHop' };
    }
    
    const jobData = await jobDataResponse.json();
    
    if (jobData.error) {
      return { success: false, error: 'HireHop API error: ' + jobData.error };
    }
    
    // Get billing data
    const billingUrl = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
    const billingResponse = await fetch(billingUrl);
    
    if (!billingResponse.ok) {
      return { success: false, error: 'Failed to fetch billing data from HireHop' };
    }
    
    const billingData = await billingResponse.json();
    
    if (billingData.error) {
      return { success: false, error: 'HireHop billing API error: ' + billingData.error };
    }
    
    // Get van info
    const vanInfo = await getVanInfoForAdmin(jobId, hirehopDomain, token);
    
    // Process billing data (simplified version of the main function)
    const processedData = processBillingDataForAdmin(billingData, vanInfo, jobData);
    
    return {
      success: true,
      jobData: {
        customerName: jobData.customer_name || jobData.CUSTOMER_NAME || jobData.NAME || '',
        customerEmail: jobData.customer_email || jobData.CUSTOMER_EMAIL || jobData.EMAIL || '',
        jobName: jobData.job_name || jobData.JOB_NAME || '',
        startDate: jobData.job_start || jobData.JOB_START || jobData.JOB_DATE || '',
        endDate: jobData.job_end || jobData.JOB_END || '',
        hireDays: calculateHireDays(jobData),
        status: jobData.STATUS || null,
        statusText: getStatusText(jobData.STATUS),
        rawJobData: jobData
      },
      financial: processedData.financial,
      excess: processedData.excess,
      payments: processedData.payments,
      debug: {
        vanInfo: vanInfo,
        billingRows: billingData.rows?.length || 0,
        adminAccess: true
      }
    };
    
  } catch (error) {
    console.error('❌ Error getting job details for admin:', error);
    return { success: false, error: error.message };
  }
}

// Get van info for admin
async function getVanInfoForAdmin(jobId, hirehopDomain, token) {
  const vehicleCategoryIds = [369, 370, 371];
  const actualVanCategoryId = 370;
  
  try {
    const encodedToken = encodeURIComponent(token);
    const itemsUrl = `https://${hirehopDomain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodedToken}`;
    
    const response = await fetch(itemsUrl);
    
    if (!response.ok) {
      return { hasVans: false, vanCount: 0, vehicles: [] };
    }
    
    const responseText = await response.text();
    const jobItems = JSON.parse(responseText);
    const items = Array.isArray(jobItems) ? jobItems : (jobItems.items || []);
    
    if (items.length > 0) {
      const vehicles = items.filter(item => 
        vehicleCategoryIds.includes(parseInt(item.CATEGORY_ID))
      );
      
      const actualVans = items.filter(item => {
        const categoryId = parseInt(item.CATEGORY_ID);
        const isVirtual = item.VIRTUAL === "1";
        return categoryId === actualVanCategoryId && !isVirtual;
      });
      
      let totalVanCount = 0;
      actualVans.forEach(van => {
        const quantity = parseInt(van.qty || van.QTY || van.quantity || van.QUANTITY || 1);
        totalVanCount += quantity;
      });
      
      return {
        hasVans: totalVanCount > 0,
        vanCount: totalVanCount,
        vehicles: vehicles,
        actualVans: actualVans
      };
    }
    
    return { hasVans: false, vanCount: 0, vehicles: [] };
  } catch (error) {
    console.error('Error checking van info for admin:', error);
    return { hasVans: false, vanCount: 0, vehicles: [] };
  }
}

// 🔧 FIXED: Process billing data for admin view with PROPER NET excess calculation
function processBillingDataForAdmin(billingData, vanInfo, jobData) {
  let totalJobValueExVAT = 0;
  let totalHireDeposits = 0;
  let netExcessDeposits = 0; // 🔧 FIXED: This will now be truly net (deposits - refunds)
  let totalInvoices = 0;
  let hireDeposits = [];
  let excessDeposits = [];
  let invoices = [];
  let excessDepositIds = new Set(); // 🔧 Track excess deposit IDs for proper refund matching
  
  // Helper function to detect excess payments
  function isExcessPayment(deposit) {
    const desc = (deposit.desc || '').toLowerCase();
    return desc.includes('excess') || desc.includes('xs') || desc.includes('insurance');
  }
  
  console.log(`📋 ADMIN BILLING ANALYSIS (FIXED NET CALCULATION): Processing ${billingData.rows?.length || 0} billing rows...`);
  
  // 🔧 PASS 1: Process deposits/payments and invoices first to build excess deposit ID set
  console.log('🔧 PASS 1: Processing deposits and invoices, building excess deposit set...');
  
  for (const row of billingData.rows || []) {
    switch (row.kind) {
      case 0: // Job total (ex-VAT)
        totalJobValueExVAT = row.accrued || 0;
        console.log(`📋 Job value ex-VAT: £${totalJobValueExVAT.toFixed(2)}`);
        break;
        
      case 1: // Invoice
        totalInvoices += row.debit || 0;
        invoices.push({
          id: row.id,
          number: row.number,
          date: row.date,
          amount: row.debit,
          owing: row.owing,
          status: row.status
        });
        break;
        
      case 6: // Deposit/Payment - Build excess deposit IDs and process amounts
        const creditAmount = row.credit || 0;
        
        const depositInfo = {
          id: row.id,
          number: row.number,
          date: row.date,
          amount: creditAmount,
          description: row.desc,
          owing: row.owing,
          enteredBy: row.data?.CREATE_USER_NAME,
          bankAccount: row.data?.ACC_ACCOUNT_ID,
          bankName: billingData.banks?.find(b => b.ID === row.data?.ACC_ACCOUNT_ID)?.NAME,
          isRefund: creditAmount < 0
        };
        
        if (isExcessPayment(row)) {
          // 🔧 FIXED: Add to net excess deposits (includes negatives for refunds)
          netExcessDeposits += creditAmount;
          excessDeposits.push({ ...depositInfo, type: 'excess' });
          
          // 🔧 CRITICAL: Track excess deposit IDs for payment application matching
          let depositIdStr = String(row.id);
          if (depositIdStr.startsWith('e')) {
            depositIdStr = depositIdStr.substring(1);
          }
          excessDepositIds.add(depositIdStr);
          
          console.log(`${creditAmount < 0 ? '💸 EXCESS REFUND' : '💰 EXCESS PAYMENT'}: ${row.number} - £${Math.abs(creditAmount).toFixed(2)} (ID: ${depositIdStr})`);
        } else {
          totalHireDeposits += creditAmount;
          hireDeposits.push({ ...depositInfo, type: 'hire' });
        }
        break;
    }
  }
  
  console.log(`🔧 PASS 1 COMPLETE: Built excess deposit ID set: [${Array.from(excessDepositIds).join(', ')}]`);
  console.log(`📊 Initial excess total: £${netExcessDeposits.toFixed(2)} (before payment applications)`);
  
  // 🔧 PASS 2: Process payment applications with complete excess deposit set
  console.log('🔧 PASS 2: Processing payment applications with complete excess deposit set...');
  
  for (const row of billingData.rows || []) {
    if (row.kind === 3) { // Payment application - 🔧 THE CRITICAL FIX IS HERE
      const paymentAmount = row.credit || 0;
      
      const paymentInfo = {
        id: row.id,
        number: row.number || '',
        date: row.date,
        amount: paymentAmount,
        description: row.desc,
        owner: row.owner,
        isRefund: paymentAmount < 0,
        enteredBy: row.data?.CREATE_USER_NAME || '',
        bankAccount: row.data?.ACC_ACCOUNT_ID,
        bankName: billingData.banks?.find(b => b.ID === row.data?.ACC_ACCOUNT_ID)?.NAME,
        parentIs: row.data?.parent_is || ''
      };
      
      // 🔧 CRITICAL FIX: Enhanced logic for payment applications
      const hasDescription = Boolean(row.desc && row.desc.trim() !== '');
      const ownerDepositId = row.data?.OWNER_DEPOSIT;
      const ownerDepositIdStr = ownerDepositId ? String(ownerDepositId) : null;
      const isFromExcessDeposit = ownerDepositIdStr && excessDepositIds.has(ownerDepositIdStr);
      
      console.log(`🔧 PASS 2 Analysis: hasDesc=${hasDescription}, amount=${paymentAmount}, ownerDepositId="${ownerDepositIdStr}", fromExcess=${isFromExcessDeposit}`);
      
      if (hasDescription && isExcessPayment(row)) {
        // 🔧 FIXED: This is an actual excess refund transaction (not just an application)
        console.log(`💸 EXCESS REFUND (kind 3): "${row.desc}" - £${Math.abs(paymentAmount).toFixed(2)} refunded`);
        
        // 🔧 CRITICAL FIX: Add to NET excess deposits (this handles refunds properly)
        netExcessDeposits += paymentAmount; // paymentAmount is negative for refunds
        excessDeposits.push({ ...paymentInfo, type: 'excess' });
        
        console.log(`📊 Updated net excess total: £${netExcessDeposits.toFixed(2)} (after ${Math.abs(paymentAmount).toFixed(2)} refund)`);
        
      } else if (isFromExcessDeposit && !hasDescription && paymentAmount < 0) {
        // 🔧 FIXED: This is excess money being used for hire (automatic application)
        const usageAmount = Math.abs(paymentAmount);
        console.log(`🔄 EXCESS USAGE: £${usageAmount.toFixed(2)} from excess deposit ${ownerDepositIdStr} applied to hire`);
        
        // Add as hire payment (usage converts excess to hire payment)
        totalHireDeposits += usageAmount;
        hireDeposits.push({
          id: row.id,
          number: `XS-USAGE-${row.id}`,
          date: row.date,
          amount: usageAmount,
          description: `Applied from excess deposit (${ownerDepositIdStr})`,
          type: 'hire',
          enteredBy: row.data?.CREATE_USER_NAME || '',
          bankName: 'Excess Usage',
          isExcessUsage: true
        });
        
        // 🔧 CRITICAL FIX: Do NOT double-subtract from netExcessDeposits here
        // The original negative deposit already reduced the net amount in Pass 1
        console.log(`📊 Hire increased by £${usageAmount.toFixed(2)} via excess usage`);
      }
      // Note: Invoice applications (no description, not from excess) are ignored for net calculations
    }
  }
  
  console.log(`📋 ADMIN BILLING SUMMARY (FIXED NET CALCULATION):`);
  console.log(`- Job value ex-VAT: £${totalJobValueExVAT.toFixed(2)}`);
  console.log(`- Total invoices: £${totalInvoices.toFixed(2)}`);
  console.log(`- 🔧 NET hire deposits: £${totalHireDeposits.toFixed(2)} (${hireDeposits.length} transactions)`);
  console.log(`- 🔧 FIXED NET excess deposits: £${netExcessDeposits.toFixed(2)} (${excessDeposits.length} transactions)`);
  console.log(`✅ FIXED: Net excess calculation now properly accounts for refunds!`);
  
  // Calculate financials using the FIXED net excess amount
  const totalJobValueIncVAT = totalJobValueExVAT * 1.2;
  const actualTotalOwed = totalInvoices > 0 ? totalInvoices : totalJobValueIncVAT;
  const remainingHireBalance = actualTotalOwed - totalHireDeposits;
  const requiredDeposit = Math.max(actualTotalOwed * 0.25, 100);
  
  // Calculate excess using FIXED net amount
  const excessPerVan = 1200;
  const totalExcessRequired = vanInfo.vanCount * excessPerVan;
  
  return {
    financial: {
      totalJobValueExVAT,
      totalJobValueIncVAT,
      totalInvoices,
      actualTotalOwed,
      totalHirePaid: totalHireDeposits,
      remainingHireBalance,
      requiredDeposit,
      depositPaid: totalHireDeposits >= requiredDeposit,
      fullyPaid: remainingHireBalance <= 0.01,
      excessPaid: netExcessDeposits, // 🔧 FIXED: Now truly net (deposits - refunds)
      currency: billingData.currency?.CODE || 'GBP'
    },
    excess: {
      amount: totalExcessRequired,
      amountPerVan: excessPerVan,
      vanCount: vanInfo.vanCount,
      vanOnHire: vanInfo.hasVans,
      alreadyPaid: netExcessDeposits, // 🔧 FIXED: Shows remaining after refunds
      vehicles: vanInfo.vehicles
    },
    payments: {
      hireDeposits,
      excessDeposits,
      invoices,
      summary: {
        totalHirePayments: hireDeposits.length,
        totalExcessPayments: excessDeposits.length,
        detectedExcessAmount: netExcessDeposits // 🔧 FIXED: Now shows true net amount
      }
    }
  };
}

// 🔧 UPDATED: Analyze excess status for admin view with remaining claimable calculation
function analyzeExcessForAdmin(jobDetails, mondayExcessCheck) {
  const analysis = {
    hasHireHopPayments: jobDetails.payments.excessDeposits.length > 0,
    hasMondayStatus: mondayExcessCheck.found && mondayExcessCheck.excessStatus,
    hasStripeLinks: mondayExcessCheck.found && mondayExcessCheck.hasStripeLink,
    hasPreAuthUpdate: mondayExcessCheck.found && mondayExcessCheck.preAuthUpdate,
    conflictDetected: false,
    recommendedActions: [],
    // 🔧 NEW: Calculate remaining claimable amount
    remainingClaimable: calculateRemainingClaimable(jobDetails, mondayExcessCheck)
  };
  
  // Detect conflicts between HireHop and Monday.com
  if (analysis.hasHireHopPayments && mondayExcessCheck.excessStatus === 'Pre-auth taken') {
    analysis.conflictDetected = true;
    analysis.recommendedActions.push('Review: HireHop shows payments but Monday.com shows pre-auth');
  }
  
  // Recommend actions based on current state and remaining amount
  if (analysis.hasPreAuthUpdate && analysis.remainingClaimable > 0) {
    analysis.recommendedActions.push(`Pre-auth available for claiming (£${analysis.remainingClaimable.toFixed(2)} remaining)`);
  } else if (analysis.hasPreAuthUpdate && analysis.remainingClaimable <= 0) {
    analysis.recommendedActions.push('Pre-auth fully claimed');
  }
  
  if (analysis.hasHireHopPayments) {
    analysis.recommendedActions.push('Excess payments available for refunding');
  }
  
  if (!analysis.hasHireHopPayments && !analysis.hasMondayStatus) {
    analysis.recommendedActions.push('No excess payments or pre-auths detected');
  }
  
  return analysis;
}

// 🔧 NEW: Calculate remaining claimable amount from pre-auth
function calculateRemainingClaimable(jobDetails, mondayExcessCheck) {
  // Get the original pre-auth amount (default £1200)
  const originalAmount = mondayExcessCheck.preAuthUpdate?.amount || 1200;
  
  // 🔧 FIXED: Use the FIXED net excess amount (which properly accounts for refunds)
  const totalClaimed = jobDetails.financial.excessPaid || 0;
  
  // Calculate remaining
  const remaining = Math.max(0, originalAmount - totalClaimed);
  
  console.log(`💰 Claimable calculation: Original £${originalAmount}, Claimed £${totalClaimed}, Remaining £${remaining}`);
  
  return remaining;
}

// 🔧 UPDATED: Determine available actions for admin with remaining amount logic
function determineAvailableActions(jobDetails, mondayExcessCheck) {
  const actions = [];
  
  // Calculate remaining claimable amount
  const remainingClaimable = calculateRemainingClaimable(jobDetails, mondayExcessCheck);
  
  // Check for pre-auth claiming with remaining amount
  if (mondayExcessCheck.found && 
      (mondayExcessCheck.excessStatus === 'Pre-auth taken' || mondayExcessCheck.hasStripeLink) &&
      remainingClaimable > 0) {
    actions.push({
      type: 'claim_preauth',
      title: 'Claim Pre-Authorization',
      description: `Claim part of the pre-auth and release the rest (£${remainingClaimable.toFixed(2)} remaining)`,
      available: true,
      metadata: {
        setupIntentId: mondayExcessCheck.preAuthUpdate?.setupIntentId || null,
        originalAmount: mondayExcessCheck.preAuthUpdate?.amount || 1200,
        remainingAmount: remainingClaimable
      }
    });
  } else if (mondayExcessCheck.found && remainingClaimable <= 0) {
    actions.push({
      type: 'preauth_fully_claimed',
      title: 'Pre-Authorization Fully Claimed',
      description: 'This pre-authorization has been fully claimed',
      available: false,
      metadata: {
        originalAmount: mondayExcessCheck.preAuthUpdate?.amount || 1200,
        totalClaimed: jobDetails.financial.excessPaid || 0
      }
    });
  }
  
  // 🔧 FIXED: Check for payment refunding using net amount
  const netExcessPaid = jobDetails.financial.excessPaid || 0;
  if (netExcessPaid > 0) {
    actions.push({
      type: 'partial_refund',
      title: 'Partial Refund',
      description: 'Refund part of the excess payment',
      available: true,
      metadata: {
        totalPaid: netExcessPaid, // 🔧 FIXED: Use net amount
        payments: jobDetails.payments.excessDeposits
      }
    });
    
    actions.push({
      type: 'full_refund',
      title: 'Full Refund',
      description: 'Refund the remaining excess payment',
      available: true,
      metadata: {
        totalPaid: netExcessPaid, // 🔧 FIXED: Use net amount
        payments: jobDetails.payments.excessDeposits
      }
    });
  }
  
  return actions;
}

// Helper functions
function calculateHireDays(jobData) {
  const startDate = jobData.JOB_DATE || jobData.job_start ? new Date(jobData.JOB_DATE || jobData.job_start) : null;
  const endDate = jobData.JOB_END || jobData.job_end ? new Date(jobData.JOB_END || jobData.job_end) : null;
  
  if (startDate && endDate) {
    return Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
  }
  
  return jobData.DURATION_DAYS ? parseInt(jobData.DURATION_DAYS) : 'N/A';
}

function getStatusText(statusCode) {
  const statusMap = {
    0: 'Enquiry',
    1: 'Provisional', 
    2: 'Booked',
    3: 'Booked',
    4: 'Booked',
    5: 'Booked',
    6: 'Booked',
    7: 'Completed',
    8: 'Booked',
    9: 'Cancelled',
    10: 'Not Interested',
    11: 'Completed'
  };
  return statusMap[statusCode] || `Unknown (${statusCode})`;
}

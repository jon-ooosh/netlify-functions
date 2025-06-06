// functions/get-admin-details.js - Get job details for admin interface
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

// Process billing data for admin view
function processBillingDataForAdmin(billingData, vanInfo, jobData) {
  let totalJobValueExVAT = 0;
  let totalHireDeposits = 0;
  let totalExcessDeposits = 0;
  let totalInvoices = 0;
  let hireDeposits = [];
  let excessDeposits = [];
  let invoices = [];
  
  // Helper function to detect excess payments
  function isExcessPayment(deposit) {
    const desc = (deposit.desc || '').toLowerCase();
    return desc.includes('excess') || desc.includes('xs') || desc.includes('insurance');
  }
  
  // Process billing rows
  for (const row of billingData.rows || []) {
    switch (row.kind) {
      case 0: // Job total (ex-VAT)
        totalJobValueExVAT = row.accrued || 0;
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
        
      case 6: // Deposit/Payment
        const depositInfo = {
          id: row.id,
          number: row.number,
          date: row.date,
          amount: row.credit,
          description: row.desc,
          owing: row.owing,
          enteredBy: row.data?.CREATE_USER_NAME,
          bankAccount: row.data?.ACC_ACCOUNT_ID,
          bankName: billingData.banks?.find(b => b.ID === row.data?.ACC_ACCOUNT_ID)?.NAME
        };
        
        if (isExcessPayment(row)) {
          totalExcessDeposits += row.credit || 0;
          excessDeposits.push({ ...depositInfo, type: 'excess' });
        } else {
          totalHireDeposits += row.credit || 0;
          hireDeposits.push({ ...depositInfo, type: 'hire' });
        }
        break;
    }
  }
  
  // Calculate financials
  const totalJobValueIncVAT = totalJobValueExVAT * 1.2;
  const actualTotalOwed = totalInvoices > 0 ? totalInvoices : totalJobValueIncVAT;
  const remainingHireBalance = actualTotalOwed - totalHireDeposits;
  const requiredDeposit = Math.max(actualTotalOwed * 0.25, 100);
  
  // Calculate excess
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
      excessPaid: totalExcessDeposits,
      currency: billingData.currency?.CODE || 'GBP'
    },
    excess: {
      amount: totalExcessRequired,
      amountPerVan: excessPerVan,
      vanCount: vanInfo.vanCount,
      vanOnHire: vanInfo.hasVans,
      alreadyPaid: totalExcessDeposits,
      vehicles: vanInfo.vehicles
    },
    payments: {
      hireDeposits,
      excessDeposits,
      invoices,
      summary: {
        totalHirePayments: hireDeposits.length,
        totalExcessPayments: excessDeposits.length,
        detectedExcessAmount: totalExcessDeposits
      }
    }
  };
}

// Analyze excess status for admin view
function analyzeExcessForAdmin(jobDetails, mondayExcessCheck) {
  const analysis = {
    hasHireHopPayments: jobDetails.payments.excessDeposits.length > 0,
    hasMondayStatus: mondayExcessCheck.found && mondayExcessCheck.excessStatus,
    hasStripeLinks: mondayExcessCheck.found && mondayExcessCheck.hasStripeLink,
    hasPreAuthUpdate: mondayExcessCheck.found && mondayExcessCheck.preAuthUpdate,
    conflictDetected: false,
    recommendedActions: []
  };
  
  // Detect conflicts between HireHop and Monday.com
  if (analysis.hasHireHopPayments && mondayExcessCheck.excessStatus === 'Pre-auth taken') {
    analysis.conflictDetected = true;
    analysis.recommendedActions.push('Review: HireHop shows payments but Monday.com shows pre-auth');
  }
  
  // Recommend actions based on current state
  if (analysis.hasPreAuthUpdate) {
    analysis.recommendedActions.push('Pre-auth available for claiming');
  }
  
  if (analysis.hasHireHopPayments) {
    analysis.recommendedActions.push('Excess payments available for refunding');
  }
  
  if (!analysis.hasHireHopPayments && !analysis.hasMondayStatus) {
    analysis.recommendedActions.push('No excess payments or pre-auths detected');
  }
  
  return analysis;
}

// Determine available actions for admin
function determineAvailableActions(jobDetails, mondayExcessCheck) {
  const actions = [];
  
  // Check for pre-auth claiming
  if (mondayExcessCheck.found && 
      (mondayExcessCheck.excessStatus === 'Pre-auth taken' || mondayExcessCheck.hasStripeLink)) {
    actions.push({
      type: 'claim_preauth',
      title: 'Claim Pre-Authorization',
      description: 'Claim part of the pre-auth and release the rest',
      available: true,
      metadata: {
        setupIntentId: mondayExcessCheck.preAuthUpdate?.setupIntentId || null,
        amount: mondayExcessCheck.preAuthUpdate?.amount || 1200
      }
    });
  }
  
  // Check for payment refunding
  if (jobDetails.payments.excessDeposits.length > 0) {
    actions.push({
      type: 'partial_refund',
      title: 'Partial Refund',
      description: 'Refund part of the excess payment',
      available: true,
      metadata: {
        totalPaid: jobDetails.financial.excessPaid,
        payments: jobDetails.payments.excessDeposits
      }
    });
    
    actions.push({
      type: 'full_refund',
      title: 'Full Refund',
      description: 'Refund the entire excess payment',
      available: true,
      metadata: {
        totalPaid: jobDetails.financial.excessPaid,
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

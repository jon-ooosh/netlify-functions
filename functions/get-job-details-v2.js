// get-job-details-v2.js - Fixed version with proper van detection and multiple van support
const fetch = require('node-fetch');

// Generate hash from job data for URL security
function generateJobHash(jobId, jobData) {
  // Create the exact same hash that HireHop template generates
  // Template format: {{job.user_id}}{{job.duration_hrs}}{{job.reference}}
  const userId = jobData.USER || '';
  const durationHrs = jobData.DURATION_HRS || '';
  const jobRef = jobId; // job.reference is the same as jobId
  
  // This matches exactly what HireHop template creates
  const expectedHash = `${userId}${durationHrs}${jobRef}`;
  
  return expectedHash;
}

// Validate provided hash against job data
function validateJobHash(jobId, jobData, providedHash) {
  // Generate the expected hash using the same format as HireHop template
  // Template: {{job.user_id}}{{job.duration_hrs}}{{job.reference}}
  const userId = jobData.USER || '';
  const durationHrs = jobData.DURATION_HRS || '';
  const jobRef = jobId;
  
  const expectedHash = `${userId}${durationHrs}${jobRef}`;
  
  console.log(`Hash validation - Expected: ${expectedHash}, Provided: ${providedHash}`);
  
  // Direct string comparison
  return expectedHash === providedHash;
}

// Function to check if vans are on hire and count them
async function getVanInfo(jobId, hirehopDomain, token) {
  const vehicleCategoryIds = [369, 370, 371];
  const mainVanCategoryId = 369; // Parent category for vans
  
  try {
    const encodedToken = encodeURIComponent(token);
    // Use the correct endpoint that works
    const itemsUrl = `https://${hirehopDomain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodedToken}`;
    
    const response = await fetch(itemsUrl);
    
    if (!response.ok) {
      console.error('Failed to fetch job items');
      return { hasVans: false, vanCount: 0, vehicles: [] };
    }
    
    const responseText = await response.text();
    
    // Parse JSON response
    let jobItems;
    try {
      jobItems = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse job items JSON:', parseError);
      return { hasVans: false, vanCount: 0, vehicles: [] };
    }
    
    // Handle both array format and object with items property
    const items = Array.isArray(jobItems) ? jobItems : (jobItems.items || []);
    
    if (items.length > 0) {
      // Find all vehicles
      const vehicles = items.filter(item => 
        vehicleCategoryIds.includes(parseInt(item.CATEGORY_ID))
      );
      
      // Count main vans (category 369) - these need excess payments
      const mainVans = vehicles.filter(item => 
        parseInt(item.CATEGORY_ID) === mainVanCategoryId
      );
      
      return {
        hasVans: vehicles.length > 0,
        vanCount: mainVans.length,
        vehicles: vehicles,
        mainVans: mainVans
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
  
  // Calculate hire duration (9am to 9am)
  const hireDays = Math.ceil((hireEnd - hireStart) / (1000 * 60 * 60 * 24));
  
  // For pre-auth timing: can start from 9am on hire start day
  const preAuthAvailableFrom = new Date(hireStart);
  preAuthAvailableFrom.setHours(9, 0, 0, 0);
  
  // Latest pre-auth date (hire end day at 9am)
  const latestPreAuthDate = new Date(hireEnd);
  latestPreAuthDate.setHours(9, 0, 0, 0);
  
  // Determine excess method
  if (hireDays <= 4) {
    if (now < preAuthAvailableFrom) {
      return {
        method: 'too_early',
        description: `Pre-authorization available from 9am on ${hireStart.toDateString()}`,
        canPreAuth: false,
        hireDays: hireDays,
        availableFrom: preAuthAvailableFrom,
        showOption: true, // Still show the option with explanation
        alternativeMessage: 'You can pay now via bank transfer or return to this page after 9am on your hire start date for card payment'
      };
    } else if (now <= latestPreAuthDate) {
      return {
        method: 'pre-auth',
        description: 'Pre-authorization (held but not charged unless needed)',
        canPreAuth: true,
        hireDays: hireDays,
        showOption: true
      };
    } else {
      return {
        method: 'too_late',
        description: 'Hire period has ended - excess payment now required as regular payment',
        canPreAuth: false,
        hireDays: hireDays,
        showOption: true
      };
    }
  } else {
    return {
      method: 'payment',
      description: 'Payment (refundable after hire)',
      canPreAuth: false,
      hireDays: hireDays,
      showOption: true
    };
  }
}

exports.handler = async (event, context) => {
  try {
    // Get job ID and hash from query parameters
    const params = new URLSearchParams(event.queryStringParameters);
    const jobId = params.get('jobId') || params.get('job');
    const hash = params.get('hash');
    
    // Validate input parameters
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
    
    // Get environment variables
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
    
    // URL encode the token
    const encodedToken = encodeURIComponent(token);
    
    // Get basic job data first
    const jobDataUrl = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
    const jobDataResponse = await fetch(jobDataUrl);
    
    if (!jobDataResponse.ok) {
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
    
    // Check if there's an error in the job data response
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
          redirectUrl: `${event.headers.referer || 'payment.html'}?jobId=${jobId}&hash=${generatedHash}`
        })
      };
    }
    
    // Get van information
    const vanInfo = await getVanInfo(jobId, hirehopDomain, token);
    
    // Calculate hire duration
    const startDate = jobData.JOB_DATE || jobData.job_start ? new Date(jobData.JOB_DATE || jobData.job_start) : null;
    const endDate = jobData.JOB_END || jobData.job_end ? new Date(jobData.JOB_END || jobData.job_end) : null;
    let hireDays = null;

    if (startDate && endDate) {
      // Calculate hire days correctly (9am to 9am = same number of calendar days)
      // Don't add 1 since hire is 9am to 9am, not full 24h periods
      hireDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    }

    // If hire days calculation failed, try using the DURATION_DAYS field
    if (!hireDays && jobData.DURATION_DAYS) {
      hireDays = parseInt(jobData.DURATION_DAYS);
    }
    
    // Get billing data using the working endpoint
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
    
    // Check if there's an error in the billing data response
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
    
    // Helper function to get status text
    function getStatusText(statusCode) {
      const statusMap = {
        0: 'Quote',
        1: 'Provisional',
        2: 'Confirmed', 
        3: 'Booked',
        4: 'Out',
        5: 'Returned',
        6: 'Cancelled'
      };
      return statusMap[statusCode] || `Unknown (${statusCode})`;
    }
    
    // Helper function to detect if a payment is for insurance excess
    function isExcessPayment(deposit) {
      const desc = (deposit.desc || '').toLowerCase();
      
      // Check for excess keywords in description
      const hasExcessKeywords = desc.includes('excess') || 
                               desc.includes('xs') || 
                               desc.includes('insurance') ||
                               desc.includes('top up');
      
      // Only use keywords - don't rely on amount
      return hasExcessKeywords;
    }
    
    // Process the billing data
    let totalJobValueExVAT = 0;
    let totalHireDeposits = 0;
    let totalExcessDeposits = 0;
    let totalInvoices = 0;
    let hireDeposits = [];
    let excessDeposits = [];
    let invoices = [];
    let payments = [];
    
    // Process each row in the billing data
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
          
          // Classify as excess or hire deposit
          if (isExcessPayment(row)) {
            totalExcessDeposits += row.credit || 0;
            excessDeposits.push({
              ...depositInfo,
              type: 'excess'
            });
          } else {
            totalHireDeposits += row.credit || 0;
            hireDeposits.push({
              ...depositInfo,
              type: 'hire'
            });
          }
          break;
          
        case 3: // Payment
          payments.push({
            id: row.id,
            date: row.date,
            amount: row.credit,
            description: row.desc,
            owner: row.owner
          });
          break;
      }
    }
    
    // Calculate totals including VAT
    const totalJobValueIncVAT = totalJobValueExVAT * 1.2; // Add 20% VAT
    const totalInvoicesIncVAT = totalInvoices; // Invoices should already include VAT
    
    // Calculate payment status (excluding excess payments)
    const totalHirePaid = totalHireDeposits;
    const remainingHireBalance = totalInvoicesIncVAT - totalHirePaid;
    
    // Calculate deposit requirements based on business rules (using VAT-inclusive amount)
    // 25% or £100, whichever is greater; full payment for jobs under £400
    let requiredDeposit = Math.max(totalJobValueIncVAT * 0.25, 100);
    if (totalJobValueIncVAT < 400) {
      requiredDeposit = totalJobValueIncVAT;
    }
    
    const depositPaid = totalHirePaid >= requiredDeposit;
    const fullyPaid = remainingHireBalance <= 0;
    
    // Calculate excess requirements based on van count
    const excessPerVan = 1200; // £1,200 per van
    const totalExcessRequired = vanInfo.vanCount * excessPerVan;
    const excessPaid = totalExcessDeposits > 0;
    
    // Determine excess payment method
    const excessPaymentTiming = vanInfo.hasVans 
      ? determineExcessPaymentTiming(
          jobData.JOB_DATE || jobData.job_start, 
          jobData.JOB_END || jobData.job_end
        )
      : {
          method: 'not_required',
          description: 'No excess required',
          canPreAuth: false,
          hireDays: hireDays,
          showOption: false
        };
    
    // Construct the response
    const result = {
      success: true,
      jobId: parseInt(jobId),
      authenticated: true, // Hash was validated
      jobData: {
        customerName: jobData.customer_name || jobData.CUSTOMER_NAME || jobData.NAME || '',
        customerEmail: jobData.customer_email || jobData.CUSTOMER_EMAIL || jobData.EMAIL || '',
        jobName: jobData.job_name || jobData.JOB_NAME || '',
        startDate: jobData.job_start || jobData.JOB_START || jobData.JOB_DATE || '',
        endDate: jobData.job_end || jobData.JOB_END || '',
        hireDays: hireDays || 'N/A',
        status: jobData.STATUS || null,
        statusText: getStatusText(jobData.STATUS),
        // Include raw job data for debugging
        rawJobData: jobData
      },
      financial: {
        // Job totals
        totalJobValueExVAT: totalJobValueExVAT,
        totalJobValueIncVAT: totalJobValueIncVAT,
        
        // Hire payments (excluding excess)
        totalHirePaid: totalHirePaid,
        totalOwing: totalInvoicesIncVAT,
        remainingHireBalance: remainingHireBalance,
        requiredDeposit: requiredDeposit,
        depositPaid: depositPaid,
        fullyPaid: fullyPaid,
        
        // Excess payments (separate tracking)
        excessPaid: totalExcessDeposits,
        excessComplete: excessPaid,
        
        currency: billingData.currency?.CODE || 'GBP'
      },
      excess: {
        amount: vanInfo.hasVans ? totalExcessRequired : 0,
        amountPerVan: excessPerVan,
        vanCount: vanInfo.vanCount,
        method: vanInfo.hasVans ? excessPaymentTiming.method : 'not_required',
        description: vanInfo.hasVans 
          ? (excessPaymentTiming.method === 'pre-auth'
            ? `Pre-authorization available for excess (${vanInfo.vanCount} van${vanInfo.vanCount > 1 ? 's' : ''})`
            : (excessPaymentTiming.method === 'payment'
              ? `Excess payment required for ${vanInfo.vanCount} van${vanInfo.vanCount > 1 ? 's' : ''}`
              : excessPaymentTiming.description))
          : 'No excess required',
        canPreAuth: vanInfo.hasVans ? excessPaymentTiming.canPreAuth : false,
        showOption: vanInfo.hasVans ? excessPaymentTiming.showOption : false,
        alternativeMessage: vanInfo.hasVans ? excessPaymentTiming.alternativeMessage : null,
        availableFrom: vanInfo.hasVans ? excessPaymentTiming.availableFrom : null,
        alreadyPaid: totalExcessDeposits,
        hasExcessPayments: excessPaid,
        vanOnHire: vanInfo.hasVans,
        hireDays: excessPaymentTiming.hireDays,
        vehicles: vanInfo.vehicles
      },
      payments: {
        hireDeposits: hireDeposits,
        excessDeposits: excessDeposits,
        invoices: invoices,
        payments: payments,
        
        // Summary for verification
        summary: {
          totalHirePayments: hireDeposits.length,
          totalExcessPayments: excessDeposits.length,
          detectedExcessAmount: totalExcessDeposits
        }
      },
      // Include raw billing data for debugging if needed
      debug: {
        billingRows: billingData.rows?.length || 0,
        availableBanks: billingData.banks?.map(b => b.NAME) || [],
        generatedHash: generateJobHash(jobId, jobData), // For debugging
        vanInfo: vanInfo
      }
    };
    
   return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(result)
    };
    
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        success: false,
        error: 'Internal server error', 
        details: error.message 
      })
    };
  }
};

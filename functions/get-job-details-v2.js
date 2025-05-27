// get-job-details-v2.js - Processes HireHop billing data to calculate payment status
const fetch = require('node-fetch');

// Function to validate the date-based hash
function validateDateHash(jobData, providedHash, jobId) {
  // Extract DURATION_HRS and USER
  const durationHrs = jobData.DURATION_HRS || '';
  const userId = jobData.USER || '';
  
  // Include job ID in the hash calculation to prevent job number tampering
  const calculatedHash = `${jobId}${durationHrs}${userId}`;
  
  // Compare the provided hash with the calculated hash
  return calculatedHash === providedHash;
}

// Function to check if a van is part of the hire
async function hasVanOnHire(jobId, hirehopDomain, token) {
  const vehicleCategoryIds = [369, 370, 371];
  
  try {
    // Construct URL to get job items
    const encodedToken = encodeURIComponent(token);
    const itemsUrl = `https://${hirehopDomain}/api/job_items.php?job=${jobId}&token=${encodedToken}`;
    
    const response = await fetch(itemsUrl);
    
    if (!response.ok) {
      console.error('Failed to fetch job items');
      return false;
    }
    
    const jobItems = await response.json();
    
    // Check if any item belongs to vehicle categories
    if (jobItems && jobItems.length > 0) {
      return jobItems.some(item => 
        vehicleCategoryIds.includes(parseInt(item.CATEGORY_ID))
      );
    }
    
    return false;
  } catch (error) {
    console.error('Error checking van on hire:', error);
    return false;
  }
}

// Function to determine excess payment timing
function determineExcessPaymentTiming(startDate, endDate) {
  const now = new Date();
  const hireStart = new Date(startDate);
  const hireEnd = new Date(endDate);
  
  // Calculate hire duration
  const hireDays = Math.ceil((hireEnd - hireStart) / (1000 * 60 * 60 * 24)) + 1;
  
  // Earliest pre-auth date (1 day before hire start)
  const earliestPreAuthDate = new Date(hireStart);
  earliestPreAuthDate.setDate(earliestPreAuthDate.getDate() - 1);
  
  // Latest pre-auth date (hire end + 1 buffer day)
  const latestPreAuthDate = new Date(hireEnd);
  latestPreAuthDate.setDate(latestPreAuthDate.getDate() + 1);
  
  // Determine excess method
  if (hireDays <= 4) {
    if (now < earliestPreAuthDate) {
      return {
        method: 'too_early',
        description: 'Too early for pre-authorization',
        canPreAuth: false
      };
    } else if (now <= latestPreAuthDate) {
      return {
        method: 'pre-auth',
        description: 'Pre-authorization (held but not charged)',
        canPreAuth: true
      };
    } else {
      return {
        method: 'too_late',
        description: 'Too late for pre-authorization',
        canPreAuth: false
      };
    }
  } else {
    return {
      method: 'payment',
      description: 'Payment (refundable after hire)',
      canPreAuth: false
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
        body: JSON.stringify({ error: 'Job ID is required' })
      };
    }
    
    // Get environment variables
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!token) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'HireHop API token not configured' })
      };
    }
    
    // URL encode the token
    const encodedToken = encodeURIComponent(token);
    
    // Get basic job data
    const jobDataUrl = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
    const jobDataResponse = await fetch(jobDataUrl);
    
    if (!jobDataResponse.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to fetch job data' })
      };
    }
    
    const jobData = await jobDataResponse.json();
    
    // Check if there's an error in the job data response
    if (jobData.error) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'HireHop API error: ' + jobData.error })
      };
    }
    
    // Validate hash if provided
    if (hash) {
      const isValidDateHash = validateDateHash(jobData, hash, jobId);
      
      if (!isValidDateHash) {
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'Invalid authentication hash' })
        };
      }
    }
    
    // Check for van on hire
    const vanOnHire = await hasVanOnHire(jobId, hirehopDomain, token);
    
    // Get billing data using the working endpoint
    const billingUrl = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
    const billingResponse = await fetch(billingUrl);
    
    if (!billingResponse.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to fetch billing data' })
      };
    }
    
    const billingData = await billingResponse.json();
    
    // Check if there's an error in the billing data response
    if (billingData.error) {
      return {
        statusCode: 500,
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
    
    // Check excess payment status (no fixed amount requirement)
    const excessPaid = totalExcessDeposits > 0;
    
    // Determine excess payment method and timing
    const excessPaymentTiming = vanOnHire 
      ? determineExcessPaymentTiming(
          jobData.JOB_DATE || jobData.job_start, 
          jobData.JOB_END || jobData.job_end
        )
      : {
          method: 'not_required',
          description: 'No excess required',
          canPreAuth: false
        };
    
    // Construct the response
    const result = {
      success: true,
      jobId: parseInt(jobId),
      jobData: {
        customerName: jobData.customer_name || jobData.CUSTOMER_NAME || jobData.NAME || '',
        customerEmail: jobData.customer_email || jobData.CUSTOMER_EMAIL || jobData.EMAIL || '',
        jobName: jobData.job_name || jobData.JOB_NAME || '',
        startDate: jobData.job_start || jobData.JOB_START || jobData.JOB_DATE || '',
        endDate: jobData.job_end || jobData.JOB_END || '',
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
        amount: vanOnHire ? 1200 : 0, // Standard £1,200 excess amount for vans
        method: excessPaymentTiming.method,
        description: excessPaymentTiming.description,
        canPreAuth: excessPaymentTiming.canPreAuth,
        alreadyPaid: totalExcessDeposits,
        hasExcessPayments: excessPaid,
        vanOnHire: vanOnHire
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
        availableBanks: billingData.banks?.map(b => b.NAME) || []
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
      body: JSON.stringify({ 
        success: false,
        error: 'Internal server error', 
        details: error.message 
      })
    };
  }
};

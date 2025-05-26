// get-job-details-v2.js - Processes HireHop billing data to calculate payment status
const fetch = require('node-fetch');
const crypto = require('crypto');

function generateSecureHash(jobId, secretKey) {
  // Simplified hash using only job ID for unique identification
  const hashInput = `${jobId}`;
  
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(hashInput);
  
  return hmac.digest('hex').slice(0, 16);
}

function validateSecureHash(jobId, providedHash, secretKey) {
  const expectedHash = generateSecureHash(jobId, secretKey);
  
  return crypto.timingSafeEqual(
    Buffer.from(expectedHash), 
    Buffer.from(providedHash)
  );
}

function validateDateHash(jobData, providedHash) {
  // Extract and format the dates in the same order
  const returnDate = jobData.JOB_END ? formatDate(new Date(jobData.JOB_END)) : '';
  const createDate = jobData.CREATE_DATE ? formatDate(new Date(jobData.CREATE_DATE)) : '';
  const startDate = jobData.JOB_DATE ? formatDate(new Date(jobData.JOB_DATE)) : '';
  
  // Combine dates in the same order as document generation
  const calculatedHash = `${returnDate}${createDate}${startDate}`;
  
  // Compare the provided hash with the calculated hash
  return calculatedHash === providedHash;
}

// Helper function to format date consistently
function formatDate(date) {
  if (!(date instanceof Date) || isNaN(date)) return '';
  
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear().toString().slice(-2);
  
  return `${day}/${month}/${year}`;
}

// In the main handler, replace the existing hash validation with:
if (hash) {
  const isValidHash = validateDateHash(jobData, hash);
  
  if (!isValidHash) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'Invalid authentication' })
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
    
    // Validate hash if provided
    if (hash) {
      const SECRET_KEY = process.env.JOB_HASH_SECRET;
      
      try {
        const isValidHash = validateSecureHash(jobId, hash, SECRET_KEY);
        
        if (!isValidHash) {
          return {
            statusCode: 403,
            body: JSON.stringify({ error: 'Invalid authentication' })
          };
        }
      } catch (hashError) {
        console.error('Hash validation error:', hashError);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Authentication validation failed' })
        };
      }
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
    
    // Calculate hire duration for excess payment method
    const startDate = jobData.JOB_DATE || jobData.job_start ? new Date(jobData.JOB_DATE || jobData.job_start) : null;
    const endDate = jobData.JOB_END || jobData.job_end ? new Date(jobData.JOB_END || jobData.job_end) : null;
    let hireDays = null;
    let excessMethod = 'payment'; // default
    
    if (startDate && endDate) {
      hireDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
      excessMethod = hireDays <= 4 ? 'pre-auth' : 'payment';
    }
    
    // If hire days calculation failed, try using the DURATION_DAYS field
    if (!hireDays && jobData.DURATION_DAYS) {
      hireDays = parseInt(jobData.DURATION_DAYS);
      excessMethod = hireDays <= 4 ? 'pre-auth' : 'payment';
    }
    
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
        hireDays: hireDays,
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
        amount: 1200, // Standard £1,200 excess amount (may vary)
        method: excessMethod,
        description: excessMethod === 'pre-auth' ? 'Pre-authorization (held but not charged)' : 'Payment (refundable after hire)',
        alreadyPaid: totalExcessDeposits,
        hasExcessPayments: excessPaid
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

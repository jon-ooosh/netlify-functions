// Netlify Function to get job details from HireHop
const axios = require('axios');

exports.handler = async function(event, context) {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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

  // Check if this is a GET request
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ message: 'Method not allowed' })
    };
  }

  // Get job ID from query parameters
  const jobId = event.queryStringParameters?.job;
  
  if (!jobId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Job ID is required' })
    };
  }

  try {
    // HireHop API credentials from environment variables
    const hireHopToken = process.env.HIREHOP_API_TOKEN;
    const hireHopBaseUrl = process.env.HIREHOP_BASE_URL || 'https://myhirehop.com/api';
    
    if (!hireHopToken) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ message: 'HireHop API token is not configured' })
      };
    }
    
    console.log(`Using HireHop API: ${hireHopBaseUrl}`);
    console.log(`Fetching job details for job ${jobId}`);
    
    // Fetch job details using the HireHop query-based API
    // First get basic job data
    const jobResponse = await axios.get(`${hireHopBaseUrl}/job_data.php`, {
      params: {
        job: jobId,
        token: hireHopToken
      }
    });
    
    console.log('Successfully fetched job data');
    
    // Get hire details to determine duration
    const hiresResponse = await axios.get(`${hireHopBaseUrl}/job_items.php`, {
      params: {
        job: jobId,
        token: hireHopToken
      }
    });
    
    console.log('Successfully fetched hire items');
    
    // Get payments
    const paymentsResponse = await axios.get(`${hireHopBaseUrl}/job_payments.php`, {
      params: {
        job: jobId,
        token: hireHopToken
      }
    });
    
    console.log('Successfully fetched payments');
    
    // Process job data
    const job = jobResponse.data;
    const hires = hiresResponse.data;
    const payments = paymentsResponse.data || [];
    
    // Check if job exists
    if (!job || job.error) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ 
          message: 'Job not found', 
          error: job?.error || 'No job data returned'
        })
      };
    }
    
    // Calculate hire duration (in days)
    let hireDuration = 0;
    if (hires && Array.isArray(hires)) {
      hires.forEach(hire => {
        if (hire.date_out && hire.date_in) {
          const startDate = new Date(hire.date_out);
          const endDate = new Date(hire.date_in);
          const duration = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1; // +1 to include both days
          hireDuration = Math.max(hireDuration, duration);
        }
      });
    }
    
    // If no duration was calculated (possibly due to data format), 
    // try to get it from the job data directly
    if (hireDuration === 0 && job.date_out && job.date_in) {
      const startDate = new Date(job.date_out);
      const endDate = new Date(job.date_in);
      hireDuration = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
    }
    
    // Get VAT information
    // First check if VAT rate is specified in the job
    let vatRate = 0.20; // Default VAT rate of 20%
    
    if (job.vat_rate) {
      vatRate = parseFloat(job.vat_rate) / 100; // Convert percentage to decimal
    }
    
    // Check if job is VAT-exempt
    const isVatExempt = job.vat_exempt === true || job.vat_exempt === "true" || job.vat_exempt === "1" || job.vat_exempt === 1;
    
    // If VAT exempt, set rate to 0
    if (isVatExempt) {
      vatRate = 0;
    }
    
    // Calculate amounts
    // Note: HireHop amounts are typically net (without VAT)
    const netTotalAmount = parseFloat(job.total_amount || job.total || 0);
    const vatAmount = netTotalAmount * vatRate;
    const grossTotalAmount = netTotalAmount + vatAmount;
    
    // Calculate paid amounts
    let netPaidAmount = 0;
    
    if (payments && Array.isArray(payments)) {
      payments.forEach(payment => {
        // Only count actual payments, not credits or other types
        if (payment.type === "payment" || payment.type === "card" || payment.type === "bank" || !payment.type) {
          netPaidAmount += parseFloat(payment.amount || 0);
        }
      });
    }
    
    // Assume payments in HireHop are also net
    const grossPaidAmount = netPaidAmount * (1 + vatRate);
    
    // Calculate remaining amount (gross)
    const grossRemainingAmount = grossTotalAmount - grossPaidAmount;
    
    // Determine deposit amount (25% or £100 of gross total, whichever is greater)
    // For bookings under £400 (gross), full payment is required
    let grossDepositAmount = 0;
    if (grossTotalAmount < 400) {
      grossDepositAmount = grossTotalAmount;
    } else {
      grossDepositAmount = Math.max(grossTotalAmount * 0.25, 100);
    }
    
    // Determine if deposit has been paid
    const depositPaid = grossPaidAmount >= grossDepositAmount;
    
    // Format amounts to 2 decimal places
    const formatAmount = (amount) => parseFloat(parseFloat(amount).toFixed(2));
    
    // Get customer email if available
    const customerEmail = job.email || job.customer_email || null;
    
    // Create response data
    const responseData = {
      jobId,
      customerName: job.customer || job.customer_name || "Customer",
      customerEmail, 
      totalAmount: formatAmount(grossTotalAmount),
      paidAmount: formatAmount(grossPaidAmount),
      remainingAmount: formatAmount(grossRemainingAmount),
      depositAmount: formatAmount(grossDepositAmount),
      depositPaid,
      hireDuration,
      requiresExcess: true, // Assuming all hires require excess
      excessMethod: hireDuration <= 4 ? 'pre-auth' : 'payment',
      vatInfo: {
        rate: vatRate,
        isExempt: isVatExempt,
        netTotal: formatAmount(netTotalAmount),
        vatAmount: formatAmount(vatAmount),
        grossTotal: formatAmount(grossTotalAmount)
      },
      rawData: {
        job: job,
        hires: hires,
        payments: payments
      }
    };
    
    console.log('Processed job data successfully');
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(responseData)
    };
  } catch (error) {
    console.log('Error:', error);
    
    // Determine the appropriate error message and status code
    let statusCode = 500;
    let message = 'Error fetching job details';
    let errorDetails = error.message;
    
    if (error.response) {
      // The request was made and the server responded with a status code
      statusCode = error.response.status;
      message = `HireHop API Error: ${error.response.statusText}`;
      errorDetails = error.response.data || error.message;
    } else if (error.request) {
      // The request was made but no response was received
      message = 'No response received from HireHop API';
      errorDetails = 'Check API URL and token';
    }
    
    return {
      statusCode,
      headers,
      body: JSON.stringify({ 
        message, 
        error: errorDetails,
        url: process.env.HIREHOP_BASE_URL || 'API URL not set'
      })
    };
  }
};
